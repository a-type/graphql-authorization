//@flow
import type {
  DocumentNode,
  FieldDefinitionNode,
  TypeNode,
  InputValueDefinitionNode,
} from 'graphql';
import { camel, pascal } from 'change-case';
import {
  get,
  mapValues,
  isPlainObject,
  isBoolean,
  isString,
  isFunction,
  isArray,
  merge,
  mapKeys,
  memoize,
} from 'lodash';
import AuthorizationError from './errors/AuthorizationError';
import {
  mapPromiseValues,
  joinPropertyPaths,
  getTypeName,
  resolveTypeDefs,
  getModelTypeNames,
  delegateTypeResolvers,
  applyDerivedTypePermissions,
  summarizeAuthResult,
  annotateAuthResultWithInputTypes,
  getQueryTypes,
  UserRoleWeakMap,
} from './utils';
import Authorizer from './Authorizer';
import type {
  AuthResult,
  AuthContext,
  QueryInputs,
  User,
  QueryRootData,
  QueryFunction,
  WrappedQueryFunction,
  Prisma,
  WithAuthorizationOptions,
} from './types';

memoize.Cache = UserRoleWeakMap;

const createAuthError = (result: AuthResult): AuthorizationError => {
  return new AuthorizationError(
    `Detailed access result: ${JSON.stringify(result)}`,
  );
};

export default class Authorized {
  static GENERATED_BASE_PERMISSION_ROLE = 'GENERATED_BASE';
  static DEFAULT_OPTIONS = {
    autoGenerateDerivedTypePermissions: true,
  };

  permissionMap: AuthMapping;
  typeDefs: DocumentNode;
  prisma: Prisma;
  options: WithAuthorizationOptions;

  constructor(
    constructorOptions: {
      prisma: Prisma,
      typeDefs: DocumentNode | string,
      permissionMap: AuthMapping,
      options?: WithAuthorizationOptions,
    } = {},
  ) {
    const {
      prisma,
      typeDefs,
      permissionMap,
      options = Authorized.DEFAULT_OPTIONS,
    } = constructorOptions;
    this.prisma = prisma;
    this.typeDefs = resolveTypeDefs(typeDefs);
    this.permissionMap = permissionMap;
    this.options = options;
  }

  setPermissionMap = (permissionMap: AuthMapping) => {
    this.permissionMap = permissionMap;
    this.forUser.cache.clear();
  };

  forUser = memoize((user: User) => {
    const { autoGenerateDerivedTypePermissions = true } = this.options;
    const prisma = this.prisma;

    const completePermissionMap = autoGenerateDerivedTypePermissions
      ? applyDerivedTypePermissions(this.typeDefs)(this.permissionMap)
      : this.permissionMap;

    const authorizer = new Authorizer(completePermissionMap);

    const wrapQuery = (
      queryFunction: QueryFunction,
      rootType: 'Query' | 'Mutation',
      queryName,
    ): WrappedQueryFunction => {
      const isRead = rootType === 'Query';

      return async (inputs: ?QueryInputs, info: string, ctx: {}) => {
        const context: AuthContext = {
          user,
          graphqlContext: ctx,
          prisma,
        };

        const inputTypes = getQueryTypes.input(
          this.typeDefs,
          rootType,
          queryName,
        );
        const responseType = getQueryTypes.response(
          this.typeDefs,
          rootType,
          queryName,
        );

        const rootData: QueryRootData = {
          rootFieldName: queryName,
          rootTypeName: pascal(rootType),
          inputs,
        };

        /**
         * PHASE 1: Validate inputs against `write` rules
         * (mutations only)
         */
        if (!isRead) {
          const validateInputs = async (): Promise<AuthResult> =>
            mapPromiseValues(
              mapValues(inputs, (value, key) =>
                authorizer.authorize({
                  typeName: inputTypes[key],
                  authType: 'write',
                  data: value,
                  context,
                  rootData,
                }),
              ),
            );

          const inputValidationResult = await validateInputs();
          const areInputsValid = summarizeAuthResult(inputValidationResult);

          if (!areInputsValid) {
            throw createAuthError(
              annotateAuthResultWithInputTypes(
                inputValidationResult,
                inputTypes,
              ),
            );
          }
        }

        /**
         * PHASE 2: Run query and get result
         */
        const queryResponse = await queryFunction(inputs, info);

        /**
         * PHASE 3: Validate response against `read` rules
         * (mutations and queries)
         */
        const validateResponse = async (): Promise<AuthResult> =>
          authorizer.authorize({
            typeName: responseType,
            authType: 'read',
            data: queryResponse,
            context,
            rootData,
          });

        const responseValidationResult = await validateResponse();
        const isResponseValid = summarizeAuthResult(responseValidationResult);

        if (!isResponseValid) {
          throw createAuthError(responseValidationResult);
        }

        return queryResponse;
      };
    };

    const query = mapValues(prisma.query, (fn, key) =>
      wrapQuery(fn.bind(prisma), 'Query', key),
    );
    const mutation = mapValues(prisma.mutation, (fn, key) =>
      wrapQuery(fn.bind(prisma), 'Mutation', key),
    );

    return {
      query,
      mutation,
      exists: prisma.exists.bind(prisma),
      request: prisma.request.bind(prisma),
    };
  });
}