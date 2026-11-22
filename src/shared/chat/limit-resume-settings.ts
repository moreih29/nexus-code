export const LIMIT_RESUME_DEFAULTS = {
  chatLimitResumeDelayMinutes: 1,
  chatLimitResumeMaxTries: 3,
  chatLimitResumeDeadlineHours: 12,
  chatLimitResumeMessage: "",
};

export type LimitResumeOptions = typeof LIMIT_RESUME_DEFAULTS;

export const LIMIT_RESUME_BOUNDS = {
  chatLimitResumeDelayMinutes: { min: 0, max: 60 },
  chatLimitResumeMaxTries: { min: 1, max: 10 },
  chatLimitResumeDeadlineHours: { min: 1, max: 168 },
};

export const LIMIT_RESUME_MESSAGE_LINE = /^[^\r\n\u2028\u2029]*$/u;
