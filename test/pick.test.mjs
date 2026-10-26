import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allowedWhileBraking, pickNext, rankTasks, scoreTask } from '../lib/pick.mjs';

const DAY = 24 * 3600 * 1000;
const NOW = Date.UTC(2026, 9, 25, 12);
const projects = [
  { id: 1, name: 'hi', importance: 'high' },
  { id: 2, name: 'mid', importance: 'normal' },
  { id: 3, name: 'lo', importance: 'low' },
];
const task = (id, projectId, urgency, ageMs = 0, status = 'queued') => ({ id, projectId, urgency, status, text: `t${id}`, createdAt: NOW - ageMs });

test('score = urgency + importance + 0.25 per full day', () => {
  assert.equal(scoreTask(task(1, 1, 'urgent'), projects, NOW), 4);
  assert.equal(scoreTask(task(1, 2, 'week'), projects, NOW), 2.5);
  assert.equal(scoreTask(task(1, 3, 'idle'), projects, NOW), 1);
  assert.equal(scoreTask(task(1, 3, 'idle', 3 * DAY), projects, NOW), 1.75);
  assert.equal(scoreTask(task(1, 3, 'idle', 3 * DAY - 1), projects, NOW), 1.5); // only full days count
  assert.equal(scoreTask(task(1, 99, 'idle'), projects, NOW), 1.5); // unknown project counts as normal
});

test('urgency and importance add up; equal scores fall back to id', () => {
  const ts = [task(1, 1, 'idle'), task(2, 3, 'week'), task(3, 3, 'urgent'), task(4, 1, 'week')];
  assert.deepEqual(rankTasks(ts, projects, NOW).map((r) => r.task.id), [3, 4, 1, 2]); // 3, 3, 2, 2
});

test('aging lets a patient idle task overtake a fresh week task', () => {
  const ts = [task(1, 2, 'week'), task(2, 2, 'idle', 5 * DAY)]; // 2.5 vs 1.5 + 1.25
  assert.equal(pickNext(ts, projects, NOW).id, 2);
  assert.equal(pickNext([task(1, 2, 'week'), task(2, 2, 'idle', 3 * DAY)], projects, NOW).id, 1); // 2.5 vs 2.25
});

test('ties go to the oldest task, then the lowest id', () => {
  const ts = [task(5, 2, 'week', 100), task(6, 2, 'week', 100), task(4, 2, 'week', 50)];
  assert.deepEqual(rankTasks(ts, projects, NOW).map((r) => r.task.id), [5, 6, 4]);
});

test('only queued tasks are picked; empty gives null', () => {
  const ts = [task(1, 1, 'urgent', 0, 'done'), task(2, 1, 'urgent', 0, 'running'), task(3, 3, 'idle')];
  assert.equal(pickNext(ts, projects, NOW).id, 3);
  assert.equal(pickNext([], projects, NOW), null);
  assert.equal(pickNext(ts.slice(0, 2), projects, NOW), null);
});

test('allowedWhileBraking: only urgent tasks', () => {
  assert.equal(allowedWhileBraking(task(1, 1, 'urgent')), true);
  assert.equal(allowedWhileBraking(task(1, 1, 'week')), false);
  assert.equal(allowedWhileBraking(task(1, 1, 'idle')), false);
  const queue = [task(1, 1, 'week'), task(2, 3, 'urgent')].filter(allowedWhileBraking);
  assert.deepEqual(queue.map((t) => t.id), [2]);
});
