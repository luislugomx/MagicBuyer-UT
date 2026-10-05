import { createCancelToken } from "./async";

// Manual tasks (buying an SBC's missing players, bulk listing): only one at a time,
// and never alongside the bot, to avoid piling up requests sent to EA.

let current = null;
const listeners = new Set();

const emit = () =>
  listeners.forEach((fn) => {
    try {
      fn(current);
    } catch (e) {}
  });

export const currentTask = () => current;

export const onTaskChange = (fn) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

// Returns the task (with its cancellation token) or null if another task is running.
export const beginTask = (label) => {
  if (current) {
    return null;
  }
  current = { label, token: createCancelToken(), startedAt: Date.now() };
  emit();
  return current;
};

export const endTask = (task) => {
  if (task && current === task) {
    current = null;
    emit();
  }
};

export const cancelTask = () => {
  if (current) {
    current.token.cancel();
  }
};
