/**
 * Compatibility facade for the player stores.
 *
 * Domain implementations live under ./store/*. Components can keep importing
 * from './store' while new code should import the narrow domain module it
 * owns. This file intentionally contains no browser history or business state.
 */
export * from './store/index'
