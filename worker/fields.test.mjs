import test from 'node:test'
import assert from 'node:assert/strict'
import { profileField } from './fields.mjs'

test('maps only explicit profile fields', () => {
  assert.equal(profileField('First Name *'), 'first_name')
  assert.equal(profileField('Email address'), 'email')
  assert.equal(profileField('Are you authorized to work?'), undefined)
  assert.equal(profileField('Previous employer email'), undefined)
  assert.equal(profileField('Full name'), 'full_name')
  assert.equal(profileField('Website'), 'portfolio')
})
