import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export type ProjectType =
  | 'node'
  | 'python'
  | 'java'
  | 'c-cpp'
  | 'go'
  | 'rust'
  | 'ruby'
  | 'php'
  | 'other'
  | 'unknown';

export type PackageManager =
  | 'npm'
  | 'yarn'
  | 'pnpm'
  | 'bun'
  | 'poetry'
  | 'uv'
  | 'pip'
  | 'maven'
  | 'gradle'
  | 'cargo'
  | 'go'
  | 'none';

export interface ProjectInfo {
  root: string;
  type: ProjectType;
  /** e.g. 'next', 'react', 'vue', 'express', 'nest' — detected from dependencies. */
  framework: string | null;
  packageManager: PackageManager;
  /** Detected languages based on config/entry files. */
  languages: string[];
  configFiles: string[];
  isGitRepo: boolean;
  /** Recommended test/build command hint (may be null). */
  testCommand: string | null;
  buildCommand: string | null;
}

function exists(p: string): boolean {
  try {
    return existsSync(p);
  } catch {
    return false;
  }
}

function readJson(p: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

const FRAMEWORK_HINTS: Array<[string[], string]> = [
  [['next'], 'next'],
  [['nuxt'], 'nuxt'],
  [['react'], 'react'],
  [['vue'], 'vue'],
  [['svelte'], 'svelte'],
  [['@nestjs/core'], 'nest'],
  [['express'], 'express'],
  [['fastify'], 'fastify'],
  [['astro'], 'astro'],
  [['remix'], 'remix'],
  [['gatsby'], 'gatsby'],
];

export function detectProject(root: string): ProjectInfo {
  const configFiles: string[] = [];
  const languages: string[] = [];
  let type: ProjectType = 'unknown';
  let packageManager: PackageManager = 'none';
  let framework: string | null = null;
  let testCommand: string | null = null;
  let buildCommand: string | null = null;

  const packageJson = join(root, 'package.json');
  const hasPkg = exists(packageJson);

  if (hasPkg) {
    type = 'node';
    packageManager = 'npm';
    const pkg = readJson(packageJson) ?? {};
    const scripts = (pkg.scripts ?? {}) as Record<string, string>;
    const deps = { ...((pkg.dependencies ?? {}) as Record<string, string>), ...((pkg.devDependencies ?? {}) as Record<string, string>) };
    for (const [keys, name] of FRAMEWORK_HINTS) {
      if (keys.some((k) => k in deps)) {
        framework = name;
        break;
      }
    }
    if (scripts.test) testCommand = 'npm test';
    if (scripts.build) buildCommand = 'npm run build';
    if (exists(join(root, 'tsconfig.json'))) languages.push('typescript');
    if (exists(join(root, 'jsconfig.json'))) languages.push('javascript');
    if (!languages.length) languages.push('javascript');

    if (exists(join(root, 'pnpm-lock.yaml'))) packageManager = 'pnpm';
    else if (exists(join(root, 'yarn.lock'))) packageManager = 'yarn';
    else if (exists(join(root, 'bun.lockb')) || exists(join(root, 'bun.lock'))) packageManager = 'bun';
  } else if (exists(join(root, 'pyproject.toml'))) {
    type = 'python';
    packageManager = 'uv';
    if (!exists(join(root, 'uv.lock')) && exists(join(root, 'poetry.lock'))) packageManager = 'poetry';
    testCommand = 'python -m pytest';
    languages.push('python');
  } else if (exists(join(root, 'requirements.txt')) || exists(join(root, 'setup.py'))) {
    type = 'python';
    packageManager = 'pip';
    testCommand = 'python -m pytest';
    languages.push('python');
  } else if (exists(join(root, 'pom.xml'))) {
    type = 'java';
    packageManager = 'maven';
    testCommand = 'mvn test';
    languages.push('java');
  } else if (exists(join(root, 'build.gradle')) || exists(join(root, 'build.gradle.kts'))) {
    type = 'java';
    packageManager = 'gradle';
    testCommand = 'gradle test';
    languages.push('java');
  } else if (exists(join(root, 'go.mod'))) {
    type = 'go';
    packageManager = 'go';
    testCommand = 'go test ./...';
    languages.push('go');
  } else if (exists(join(root, 'Cargo.toml'))) {
    type = 'rust';
    packageManager = 'cargo';
    testCommand = 'cargo test';
    languages.push('rust');
  } else if (exists(join(root, 'CMakeLists.txt'))) {
    type = 'c-cpp';
    languages.push('c', 'c++');
  } else if (exists(join(root, 'Makefile')) || exists(join(root, 'makefile'))) {
    type = 'c-cpp';
    languages.push('c', 'c++');
  } else if (exists(join(root, 'Gemfile'))) {
    type = 'ruby';
    languages.push('ruby');
  } else if (exists(join(root, 'composer.json'))) {
    type = 'php';
    languages.push('php');
  } else if (exists(join(root, 'index.html')) || exists(join(root, 'src'))) {
    type = 'other';
  }

  const allConfigs = [
    'package.json', 'tsconfig.json', 'jsconfig.json', 'vite.config.ts', 'vite.config.js',
    'next.config.mjs', 'next.config.js', 'webpack.config.js', 'eslint.config.js', '.eslintrc.json',
    'jest.config.js', 'vitest.config.ts', 'prettier.config.js', '.prettierrc', 'tailwind.config.js',
    'pyproject.toml', 'requirements.txt', 'setup.py', 'pom.xml', 'build.gradle', 'go.mod', 'Cargo.toml',
    'Gemfile', 'composer.json', '.github/workflows/ci.yml', 'Dockerfile', 'docker-compose.yml',
  ];
  for (const c of allConfigs) {
    if (exists(join(root, c))) configFiles.push(c);
  }

  // Common config files detection for node projects
  if (type === 'node') {
    if (exists(join(root, 'vite.config.ts')) || exists(join(root, 'vite.config.js'))) {
      if (!framework) framework = 'vite';
    }
    if (exists(join(root, 'jest.config.js')) || exists(join(root, 'jest.config.ts'))) {
      if (!testCommand) testCommand = 'npm test';
    }
  }

  return {
    root,
    type,
    framework,
    packageManager,
    languages: [...new Set(languages)],
    configFiles,
    isGitRepo: exists(join(root, '.git')),
    testCommand,
    buildCommand,
  };
}

export function projectLabel(info: ProjectInfo): string {
  const bits: string[] = [info.type];
  if (info.framework) bits.push(info.framework);
  return bits.join(' · ');
}
