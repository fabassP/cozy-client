import mapValues from 'lodash/mapValues'
import difference from 'lodash/difference'
import intersection from 'lodash/intersection'
import concat from 'lodash/concat'
import isPlainObject from 'lodash/isPlainObject'
import uniq from 'lodash/uniq'
import orderBy from 'lodash/orderBy'
import isArray from 'lodash/isArray'
import isString from 'lodash/isString'
import get from 'lodash/get'
import sift from 'sift'

import flag from 'cozy-flags'

import { getDocumentFromSlice } from './documents'
import { isReceivingMutationResult } from './mutations'
import { properId } from './helpers'
import { isAGetByIdQuery, QueryDefinition } from '../queries/dsl'
import { QueryState, CozyClientDocument } from '../types'

/**
 * @typedef {object} InitQueryOptions
 * @param {boolean} autoUpdate - Should the query auto update (true by default)
 */

const INIT_QUERY = 'INIT_QUERY'
const LOAD_QUERY = 'LOAD_QUERY'
const RECEIVE_QUERY_RESULT = 'RECEIVE_QUERY_RESULT'
const RECEIVE_QUERY_ERROR = 'RECEIVE_QUERY_ERROR'

// Read if the devtools are open to store the execution time
// This is done at runtime to not read the value everytime
// we receive a result. So you have to refresh your page
// in order to get the stats
const executionStatsEnabled = flag('debug')

export const isQueryAction = action =>
  [INIT_QUERY, LOAD_QUERY, RECEIVE_QUERY_RESULT, RECEIVE_QUERY_ERROR].indexOf(
    action.type
  ) !== -1

export const isReceivingData = action => action.type === RECEIVE_QUERY_RESULT

// reducers
const queryInitialState = {
  id: null,
  definition: null,
  fetchStatus: 'pending',
  lastFetch: null,
  lastUpdate: null,
  lastError: null,
  hasMore: false,
  count: 0,
  data: [],
  bookmark: null
}

const updateQueryDataFromResponse = (queryState, response, nextDocuments) => {
  let updatedIds = uniq([...queryState.data, ...response.data.map(properId)])
  if (queryState.definition.sort) {
    const sorter = makeSorterFromDefinition(queryState.definition)
    const doctype = queryState.definition.doctype
    const allDocs = nextDocuments[doctype]
    const docs = updatedIds.map(_id => allDocs[_id])
    const sortedDocs = sorter(docs)
    updatedIds = sortedDocs.map(properId)
  }
  return updatedIds
}

const query = (state = queryInitialState, action, nextDocuments) => {
  switch (action.type) {
    case INIT_QUERY:
      if (
        state.lastUpdate &&
        state.id === action.queryId &&
        state.definition === action.queryDefinition
      ) {
        return state
      }
      return {
        ...state,
        id: action.queryId,
        definition: action.queryDefinition,
        fetchStatus: state.lastUpdate ? state.fetchStatus : 'pending'
      }
    case LOAD_QUERY:
      if (state.fetchStatus === 'loading') {
        return state
      }
      return {
        ...state,
        fetchStatus: 'loading'
      }
    case RECEIVE_QUERY_RESULT: {
      const response = action.response
      if (!response.data) {
        return state
      }

      const common = {
        fetchStatus: 'loaded',
        lastFetch: Date.now(),
        lastUpdate: Date.now(),
        ...(executionStatsEnabled && {
          execution_stats: response.execution_stats
        })
      }

      if (!Array.isArray(response.data)) {
        return {
          ...state,
          ...common,
          hasMore: false,
          count: 1,
          data: [properId(response.data)]
        }
      }
      return {
        ...state,
        ...common,
        bookmark: response.bookmark || null,
        hasMore: response.next !== undefined ? response.next : state.hasMore,
        count:
          response.meta && response.meta.count
            ? response.meta.count
            : response.data.length,
        data: updateQueryDataFromResponse(state, response, nextDocuments)
      }
    }
    case RECEIVE_QUERY_ERROR:
      return {
        ...state,
        id: action.queryId,
        fetchStatus: 'failed',
        lastError: action.error
      }
    default:
      return state
  }
}

/**
 * Normalize sift selector
 *
 * @returns {object}
 */
export const convert$gtNullSelectors = selector => {
  const result = {}
  for (const [key, value] of Object.entries(selector)) {
    const convertedValue = isPlainObject(value)
      ? convert$gtNullSelectors(value)
      : value
    const convertedKey =
      key === '$gt' && convertedValue === null ? '$gtnull' : key

    result[convertedKey] = convertedValue
  }
  return result
}

/**
 * Merges query selectors with query partial indexes
 *
 * @param {object} queryDefinition - A query definition
 * @returns {object} A query definition selector
 */
export const mergeSelectorAndPartialIndex = queryDefinition => ({
  ...queryDefinition.selector,
  ...get(queryDefinition, 'partialFilter')
})

/**
 * @param  {QueryDefinition} queryDefinition
 * @return {function(CozyClientDocument): Boolean}
 */
const getSelectorFilterFn = queryDefinition => {
  if (queryDefinition.selector) {
    const selectors = mergeSelectorAndPartialIndex(queryDefinition)
    // sift does not work like couchdb when using { $gt: null } as a selector, so we use a custom operator
    sift.use({
      $gtnull: (_selectorValue, actualValue) => {
        return !!actualValue
      }
    })
    return sift(convert$gtNullSelectors(selectors))
  } else if (queryDefinition.id) {
    /** @type {object} */
    const siftQuery = { _id: queryDefinition.id }
    return sift(siftQuery)
  } else if (queryDefinition.ids) {
    /** @type {object} */
    const siftQuery = { _id: { $in: queryDefinition.ids } }
    return sift(siftQuery)
  } else {
    return null
  }
}

/**
 *
 * Returns a predicate function that checks if a document should be
 * included in the result of the query.
 * 
 * @param  {QueryState} query - Definition of the query
 * @return {function(CozyClientDocument): Boolean} Predicate function
 */
const getQueryDocumentsChecker = query => {
  const qdoctype = query.definition.doctype
  const selectorFilterFn = getSelectorFilterFn(query.definition)
  return datum => {
    const ddoctype = datum._type
    if (ddoctype !== qdoctype) return false
    if (datum._deleted) return false
    if (!selectorFilterFn) return true
    return !!selectorFilterFn(datum)
  }
}

const makeCaseInsensitiveStringSorter = attrName => item => {
  const attrValue = get(item, attrName)
  return isString(attrValue) ? attrValue.toLowerCase() : attrValue
}

/**
 * Creates a sort function from a definition.
 *
 * Used to sort query results inside the store when creating a file or
 * receiving updates.
 *
 * @param {QueryDefinition} definition
 * @returns {function(Array<CozyClientDocument>): Array<CozyClientDocument>}
 *
 * @private
 */
export const makeSorterFromDefinition = definition => {
  const sort = definition.sort
  if (!sort) {
    return docs => docs
  } else if (!isArray(definition.sort)) {
    console.warn(
      'Correct update of queries with a sort that is not an array is not supported. Use an array as argument of QueryDefinition::sort'
    )
    return docs => docs
  } else {
    const attributeOrders = sort.map(x => Object.entries(x)[0])
    const attrs = attributeOrders
      .map(x => x[0])
      .map(makeCaseInsensitiveStringSorter)
    const orders = attributeOrders.map(x => x[1])
    return docs => orderBy(docs, attrs, orders)
  }
}

/**
 * Updates query state when new data comes in
 * 
 * @param  {QueryState} query - Current query state
 * @param  {Array<CozyClientDocument>} newData - New documents (in most case from the server)
 * @param  {Array<CozyClientDocument>} nextDocuments 
 * @return {QueryState} - Updated query state               
 */
const updateData = (query, newData, nextDocuments) => {
  const isFulfilled = getQueryDocumentsChecker(query)
  const matchedIds = newData.filter(doc => isFulfilled(doc)).map(properId)
  const unmatchedIds = newData.filter(doc => !isFulfilled(doc)).map(properId)
  const originalIds = query.data
  const toRemove = intersection(originalIds, unmatchedIds)
  const toAdd = difference(matchedIds, originalIds)
  const toUpdate = intersection(originalIds, matchedIds)

  const changed = toRemove.length || toAdd.length || toUpdate.length

  // concat doesn't check duplicates (contrarily to union), which is ok as
  // toAdd does not contain any id present in originalIds, by construction.
  // It is also faster than union.
  let updatedData = difference(concat(originalIds, toAdd), toRemove)

  if (query.definition.sort && nextDocuments) {
    const sorter = makeSorterFromDefinition(query.definition)
    const allDocs = nextDocuments[query.definition.doctype]
    const docs = updatedData.map(_id => allDocs[_id])
    const sortedDocs = sorter(docs)
    updatedData = sortedDocs.map(properId)
  }

  return {
    ...query,
    data: updatedData,
    count: updatedData.length,
    lastUpdate: changed ? Date.now() : query.lastUpdate
  }
}

const autoQueryUpdater = (action, nextDocuments) => query => {
  let data = get(action, 'response.data') || get(action, 'definition.document')

  if (!data) return query

  if (!Array.isArray(data)) {
    data = [data]
  }
  if (!data.length) {
    return query
  }

  if (query.definition.doctype !== data[0]._type) {
    return query
  }

  return updateData(query, data, nextDocuments)
}

const manualQueryUpdater = (action, documents) => query => {
  const updateQueries = action.updateQueries
  const response = action.response
  const updater = updateQueries[query.id]
  if (!updater) {
    return query
  }

  const doctype = query.definition.doctype
  const oldData = query.data
  const oldDocs = mapIdsToDocuments(documents, doctype, oldData)
  const newData = updater(oldDocs, response)
  const newDataIds = newData.map(properId)
  return {
    ...query,
    data: newDataIds,
    count: newDataIds.length,
    lastUpdate: Date.now()
  }
}

const queries = (
  state = {},
  action,
  nextDocuments = {},
  haveDocumentsChanged = true
) => {
  if (action.type == INIT_QUERY) {
    const newQueryState = query(state[action.queryId], action)
    // Do not create new object unnecessarily
    if (newQueryState === state[action.queryId]) {
      return state
    }
    return {
      ...state,
      [action.queryId]: newQueryState
    }
  }
  if (isQueryAction(action)) {
    const updater = autoQueryUpdater(action, nextDocuments)
    return mapValues(state, queryState => {
      if (queryState.id == action.queryId) {
        return query(queryState, action, nextDocuments)
      } else if (haveDocumentsChanged) {
        return updater(queryState)
      } else {
        return queryState
      }
    })
  }
  if (isReceivingMutationResult(action)) {
    const updater = action.updateQueries
      ? manualQueryUpdater(action, nextDocuments)
      : autoQueryUpdater(action, nextDocuments)
    return mapValues(state, updater)
  }
  return state
}
export default queries

// actions
export const initQuery = (queryId, queryDefinition) => {
  if (!queryDefinition.doctype) {
    throw new Error('Cannot init query with no doctype')
  }
  return {
    type: INIT_QUERY,
    queryId,
    queryDefinition
  }
}

export const loadQuery = queryId => {
  return {
    type: LOAD_QUERY,
    queryId
  }
}

export const receiveQueryResult = (queryId, response, options = {}) => ({
  type: RECEIVE_QUERY_RESULT,
  queryId,
  response,
  ...options
})

export const receiveQueryError = (queryId, error) => ({
  type: RECEIVE_QUERY_ERROR,
  queryId,
  error
})

// selectors
const mapIdsToDocuments = (documents, doctype, ids) =>
  ids.map(id => getDocumentFromSlice(documents, doctype, id))

export const getQueryFromSlice = (state, queryId, documents) => {
  if (!state || !state[queryId]) {
    return { ...queryInitialState, data: null }
  }
  const query = state[queryId]
  return documents
    ? {
        ...query,
        data: mapIdsToDocuments(documents, query.definition.doctype, query.data)
      }
    : query
}

export class QueryIDGenerator {
  constructor() {
    this.idCounter = 1
  }

  /**
   * Generates a random id for unamed queries
   */
  generateRandomId() {
    const id = this.idCounter
    this.idCounter++
    return id.toString() 
  }

  /**
   * Generates an id for queries
   * If the query is a getById only query,
   * we can generate a name for it.
   *
   * If not, let's generate a random id
   *
   * @param {QueryDefinition} queryDefinition The query definition
   * @returns {string}
   */
  generateId(queryDefinition) {
    if (!isAGetByIdQuery(queryDefinition)) {
      return this.generateRandomId()
    } else {
      const { id, doctype } = queryDefinition
      return `${doctype}/${id}`
    }
  }
}

QueryIDGenerator.UNNAMED = 'unnamed'
