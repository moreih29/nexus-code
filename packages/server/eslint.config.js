// @ts-check
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    // Base: TypeScript files only
    files: ['src/**/*.ts'],
    extends: [tseslint.configs.base],
  },
  {
    // Boundary rule: routes/, services/, domain/ must not import adapters/claude-code/**
    files: [
      'src/routes/**/*.ts',
      'src/services/**/*.ts',
      'src/domain/**/*.ts',
    ],
    // Exclude test files — boundaries apply to production code only
    ignores: ['**/__tests__/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: '(\\.\\./)+(adapters/claude-code)/',
              message:
                'routes/, services/, and domain/ must not import adapters/claude-code/**. ' +
                'Inject claude-code types via ports or constructor parameters instead.',
            },
          ],
        },
      ],
    },
  },
  {
    // Boundary rule: adapters/approval/ and adapters/security/ must not import adapters/claude-code/**
    files: ['src/adapters/approval/**/*.ts', 'src/adapters/security/**/*.ts'],
    ignores: ['**/__tests__/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: '(\\.\\./)+(adapters/claude-code)/',
              message:
                'adapters/approval/ and adapters/security/ must not import adapters/claude-code/**.',
            },
          ],
        },
      ],
    },
  },
)
