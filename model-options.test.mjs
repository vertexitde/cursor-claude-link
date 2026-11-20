import test from 'node:test';
import assert from 'node:assert/strict';
import {modelOptions} from './model-options.mjs';

const row = (value, displayName, description, resolvedModel = value) => ({value, displayName, description, resolvedModel, supportedEffortLevels:['medium']});

test('model names come from the description prefix on older CLIs', () => {
  const options = modelOptions([row('claude-opus-4-8', 'claude-opus-4-8', 'Opus 4.8 · Best for everyday, complex tasks')]);
  assert.deepEqual(options.map(o => o.displayName), ['Claude Opus 4.8']);
});

test('model names come from displayName when the description is plain (CLI 2.1.291)', () => {
  const options = modelOptions([
    row('default', 'Default (recommended)', 'Opus 5.5 · Best for everyday, complex tasks', 'claude-opus-5-5'),
    row('opus', 'Opus 5.5', 'For complex work and everyday tasks', 'claude-opus-5-5'),
    row('claude-opus-4-8', 'Opus 4.8', 'Best for everyday, complex tasks'),
    row('claude-sonnet-4-6', 'Sonnet 4.6', 'Efficient for routine tasks')]);
  assert.deepEqual(options.map(o => o.displayName), ['Claude Opus 5.5', 'Claude Opus 4.8', 'Claude Sonnet 4.6']);
});

test('generic displayNames take the versioned name from the description (CLI 2.1.322)', () => {
  const options = modelOptions([
    row('opus', 'Opus', 'Opus 5.5 · Best for everyday, complex tasks · $4/$20 per Mtok', 'claude-opus-5-5'),
    row('claude-fable-5-2[1m]', 'Fable', 'Fable 5.2 · Most capable for your hardest and longest-running tasks', 'claude-fable-5-2'),
    row('haiku', 'Haiku', 'Haiku 5.5 · Fastest for quick answers · $0.10/$0.50 per Mtok', 'claude-haiku-5-5')]);
  assert.deepEqual(options.map(o => o.displayName), ['Claude Opus 5.5', 'Claude Fable 5.2', 'Claude Haiku 5.5']);
  assert.equal(options[1].value, 'claude-fable-5-2');
  assert.equal(options[1].extended, true, 'the 1M variant stays available');
});
