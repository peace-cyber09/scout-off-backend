/**
 * GraphQL endpoint factory.
 *
 * Creates a graphql-yoga handler and mounts it on the Express app at /graphql.
 *
 * Security controls:
 *   - Depth limiting: queries deeper than MAX_DEPTH levels are rejected (DoS guard)
 *     Implemented as a custom GraphQL validation rule using the standard
 *     `graphql` ValidationContext API — no external plugin required.
 *   - Introspection: disabled in production (NODE_ENV=production)
 *   - Auth: extracted in context; resolvers enforce it per-field
 *
 * The endpoint is mounted alongside the REST API (not replacing it).
 */

import { createYoga, createSchema } from 'graphql-yoga';
import { useValidationRule } from '@envelop/core';
import { Application } from 'express';
import { GraphQLError, ValidationContext, ASTNode, Kind } from 'graphql';
import { typeDefs } from './schema';
import { resolvers } from './resolvers';
import { createContext } from './context';
import { logger } from '../utils/logger';
import { createPersistedOperationsPlugin } from './persisted-operations';
import config from '../config';

const MAX_DEPTH = 5;

// ─── Custom depth-limit validation rule ──────────────────────────────────────

/**
 * Returns a GraphQL validation rule that rejects queries deeper than maxDepth.
 *
 * Depth is measured as the maximum nesting of selection sets in a single
 * operation. Fragment spreads are followed so inlined and named fragments
 * are both counted. Introspection fields (__schema, __type) are excluded
 * because graphql-yoga handles introspection before validation runs when
 * it is enabled, and we want depth-limit to apply only to data queries.
 */
function createDepthLimitRule(maxDepth: number) {
  return function depthLimitRule(context: ValidationContext) {
    return {
      OperationDefinition(operation: ASTNode) {
        if (operation.kind !== Kind.OPERATION_DEFINITION) return;

        const fragments = context.getDocument().definitions
          .filter((d): d is import('graphql').FragmentDefinitionNode =>
            d.kind === Kind.FRAGMENT_DEFINITION,
          )
          .reduce<Record<string, import('graphql').FragmentDefinitionNode>>((acc, frag) => {
            acc[frag.name.value] = frag;
            return acc;
          }, {});

        function measureDepth(
          node: import('graphql').SelectionSetNode | undefined,
          depth: number,
          visited: Set<string>,
        ): number {
          if (!node) return depth;
          let max = depth;
          for (const selection of node.selections) {
            if (selection.kind === Kind.FIELD) {
              // skip meta-fields
              if (selection.name.value.startsWith('__')) continue;
              const childDepth = measureDepth(selection.selectionSet, depth + 1, visited);
              if (childDepth > max) max = childDepth;
            } else if (selection.kind === Kind.INLINE_FRAGMENT) {
              const childDepth = measureDepth(selection.selectionSet, depth, visited);
              if (childDepth > max) max = childDepth;
            } else if (selection.kind === Kind.FRAGMENT_SPREAD) {
              const fragName = selection.name.value;
              if (!visited.has(fragName) && fragments[fragName]) {
                visited.add(fragName);
                const childDepth = measureDepth(
                  fragments[fragName].selectionSet,
                  depth,
                  visited,
                );
                if (childDepth > max) max = childDepth;
              }
            }
          }
          return max;
        }

        const depth = measureDepth(operation.selectionSet, 0, new Set());
        if (depth > maxDepth) {
          context.reportError(
            new GraphQLError(
              `Query depth ${depth} exceeds maximum allowed depth of ${maxDepth}.`,
              { nodes: [operation] },
            ),
          );
        }
      },
    };
  };
}

// ─── Production introspection-blocking plugin ────────────────────────────────

/**
 * graphql-yoga plugin that intercepts execution and returns an error for
 * introspection queries (__schema / __type) when running in production.
 *
 * Uses the `onExecute` lifecycle hook + `setResultAndStopExecution` to short-
 * circuit execution before any resolver runs — the cleanest approach for this
 * version of graphql-yoga that doesn't require an external depth-limit package.
 */
function createBlockIntrospectionPlugin() {
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    onExecute({ args, setResultAndStopExecution }: any) {
      const defs: readonly import('graphql').DefinitionNode[] =
        args?.document?.definitions ?? [];
      for (const def of defs) {
        if (def.kind !== Kind.OPERATION_DEFINITION) continue;
        for (const sel of def.selectionSet.selections) {
          if (
            sel.kind === Kind.FIELD &&
            (sel.name.value === '__schema' || sel.name.value === '__type')
          ) {
            setResultAndStopExecution({
              errors: [
                new GraphQLError('GraphQL introspection is disabled in production.', {
                  extensions: { code: 'INTROSPECTION_DISABLED' },
                }),
              ],
            });
            return;
          }
        }
      }
    },
  };
}

// ─── Mount ────────────────────────────────────────────────────────────────────

/**
 * Creates and mounts the GraphQL endpoint on `app` at `/graphql`.
 * Call this from `src/app.ts` after all other middleware is set up.
 */
export function mountGraphQL(app: Application): void {
  const isProduction = process.env.NODE_ENV === 'production';

  // Persisted operations plugin is always enabled (controls both dev and prod modes)
  const plugins = [
    useValidationRule(createDepthLimitRule(MAX_DEPTH)),
    createPersistedOperationsPlugin(),
    ...(isProduction ? [createBlockIntrospectionPlugin()] : []),
  ];
  
  const yoga = createYoga({
    schema: createSchema({
      typeDefs,
      resolvers,
    }),
    context: createContext,
    // Depth limiting and persisted operations via plugins; introspection blocking for production
    plugins,
    // graphql-yoga manages its own /graphql path
    graphqlEndpoint: '/graphql',
    // Log errors (graphql-yoga catches them internally)
    maskedErrors: isProduction,
    logging: {
      debug: (...args) => logger.debug(args),
      info: (...args) => logger.info(args),
      warn: (...args) => logger.warn(args),
      error: (...args) => logger.error(args),
    },
  });

  // graphql-yoga returns a standard request handler compatible with Express
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.use('/graphql', yoga as any);

  logger.info(
    `[graphql] endpoint mounted at /graphql (introspection=${!isProduction}, maxDepth=${MAX_DEPTH})`,
  );
}
