// Pure task picker. Score = urgency + importance + aging; ties go to the oldest task.
export const URGENCY_SCORE = { urgent: 3, week: 2, idle: 1 };
export const IMPORTANCE_SCORE = { high: 1, normal: 0.5, low: 0 };
export const AGING_PER_DAY = 0.25;
const DAY = 24 * 3600 * 1000;

export function scoreTask(task, projects, now) {
  const project = projects.find((p) => String(p.id) === String(task.projectId));
  const urgency = URGENCY_SCORE[task.urgency] ?? URGENCY_SCORE.idle;
  const importance = IMPORTANCE_SCORE[project?.importance] ?? IMPORTANCE_SCORE.normal;
  const days = Math.max(0, Math.floor((now - task.createdAt) / DAY));
  return urgency + importance + AGING_PER_DAY * days;
}

// Queued tasks, best first, each as { task, score }.
export function rankTasks(tasks, projects, now) {
  return tasks
    .filter((t) => t.status === 'queued')
    .map((task) => ({ task, score: scoreTask(task, projects, now) }))
    .sort((a, b) => b.score - a.score || a.task.createdAt - b.task.createdAt || Number(a.task.id) - Number(b.task.id));
}

export function pickNext(tasks, projects, now) {
  return rankTasks(tasks, projects, now)[0]?.task ?? null;
}

// While the brake is on, only urgent tasks may start.
export function allowedWhileBraking(task) {
  return task.urgency === 'urgent';
}
