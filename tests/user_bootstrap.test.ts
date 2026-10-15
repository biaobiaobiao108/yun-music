import { afterEach, expect, test } from 'bun:test'
import { closeDb, getDb, initDatabase } from '@/database'
import { initializeUsersFromDatabase } from '@/user/data'

const previousLx = global.lx
afterEach(() => {
  closeDb()
  global.lx = previousLx
})

test('an initialized empty user table does not recreate bootstrap accounts', () => {
  closeDb()
  initDatabase(':memory:')
  global.lx = { config: { users: [] } } as unknown as typeof global.lx
  const bootstrap = [{ name: 'initial', password: 'bootstrap-password' }] as LX.Config['users']
  initializeUsersFromDatabase(bootstrap)
  expect(getDb().query('SELECT name FROM users').all()).toEqual([{ name: 'initial' }])
  getDb().run('DELETE FROM users')
  initializeUsersFromDatabase(bootstrap)
  expect(getDb().query('SELECT name FROM users').all()).toEqual([])
  expect(global.lx.config.users).toEqual([])
})
