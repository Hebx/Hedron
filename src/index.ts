/**
 * Hedron Agent SDK — public entry point.
 *
 * v0.2 surface. Subpath imports are also available:
 *   import { Router } from 'hedron/router'
 *   import { Broker } from 'hedron/broker'
 *   import { policy } from 'hedron/policy'
 *   import { MockHcsEmitter } from 'hedron/hcs'
 *   import { MockPaymentAdapter } from 'hedron/settlement'
 */

export * as types from './types'
export * as errors from './errors'
export * from './config'
export * from './registry'
export * from './quotes'
export * from './router'
export * from './broker'
export * from './settlement'
export * from './hcs'
export * from './receipts'
export * from './policy'
export * as utils from './utils'

export const VERSION = '0.2.0-alpha.0'
export const SDK_NAME = 'hedron'
