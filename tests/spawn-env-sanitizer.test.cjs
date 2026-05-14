'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  BILLING_LEAK_ENV_KEYS,
  buildSanitizedSpawnEnv,
  stripSanitizerMeta,
} = require('../dist-ts/src/spawn-env-sanitizer');

function describe(n, f) { console.log('\n=== ' + n + ' ==='); f(); }
function it(n, f) {
  try { f(); console.log('  OK  ' + n); }
  catch (e) { console.error('  FAIL ' + n + ' — ' + (e && e.stack ? e.stack : e.message)); process.exitCode = 1; }
}

// process.env を退避・復元するヘルパー
function withMockEnv(mockEnv, fn) {
  const original = { ...process.env };
  // 一旦全削除して mockEnv で組み立て直す (順序依存を排除)
  for (const k of Object.keys(process.env)) delete process.env[k];
  for (const [k, v] of Object.entries(mockEnv)) {
    if (v != null) process.env[k] = v;
  }
  try {
    fn();
  } finally {
    for (const k of Object.keys(process.env)) delete process.env[k];
    for (const [k, v] of Object.entries(original)) {
      process.env[k] = v;
    }
  }
}

describe('BILLING_LEAK_ENV_KEYS', () => {
  it('contains ANTHROPIC_API_KEY at minimum', () => {
    assert.ok(BILLING_LEAK_ENV_KEYS.includes('ANTHROPIC_API_KEY'));
  });

  it('contains all critical leak vectors', () => {
    const required = [
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_AUTH_TOKEN',
      'CLAUDE_CODE_USE_BEDROCK',
      'CLAUDE_CODE_USE_VERTEX',
    ];
    for (const k of required) {
      assert.ok(BILLING_LEAK_ENV_KEYS.includes(k), `${k} should be in BILLING_LEAK_ENV_KEYS`);
    }
  });
});

describe('buildSanitizedSpawnEnv — env サニタイズ', () => {
  it('removes ANTHROPIC_API_KEY when present', () => {
    withMockEnv({
      PATH: '/usr/bin',
      ANTHROPIC_API_KEY: 'sk-ant-test-key-xxx',
      OTHER_VAR: 'keep-me',
    }, () => {
      const env = buildSanitizedSpawnEnv({ providerId: 'claude' });
      assert.equal(env.ANTHROPIC_API_KEY, undefined);
      assert.equal(env.OTHER_VAR, 'keep-me');
      assert.equal(env.PATH, '/usr/bin');
      assert.ok(env.__removedKeys.includes('ANTHROPIC_API_KEY'));
    });
  });

  it('removes all known billing leak keys at once', () => {
    const leaks = {
      ANTHROPIC_API_KEY: 'sk-1',
      ANTHROPIC_AUTH_TOKEN: 'tok-1',
      ANTHROPIC_API_URL: 'https://example.com',
      CLAUDE_CODE_USE_BEDROCK: '1',
      CLAUDE_CODE_USE_VERTEX: '1',
      AWS_BEARER_TOKEN_BEDROCK: 'aws-1',
      ANTHROPIC_VERTEX_PROJECT_ID: 'gcp-proj',
    };
    withMockEnv({ ...leaks, PATH: '/usr/bin' }, () => {
      const env = buildSanitizedSpawnEnv({ providerId: 'claude' });
      for (const k of Object.keys(leaks)) {
        assert.equal(env[k], undefined, `${k} should be removed`);
        assert.ok(env.__removedKeys.includes(k), `${k} should be in __removedKeys`);
      }
    });
  });

  it('does NOT remove non-leak env (PATH, USER, etc)', () => {
    withMockEnv({
      PATH: '/usr/bin',
      USER: 'alice',
      LANG: 'ja_JP.UTF-8',
      SOME_APP_CONFIG: 'value',
    }, () => {
      const env = buildSanitizedSpawnEnv({});
      assert.equal(env.PATH, '/usr/bin');
      assert.equal(env.USER, 'alice');
      assert.equal(env.LANG, 'ja_JP.UTF-8');
      assert.equal(env.SOME_APP_CONFIG, 'value');
    });
  });

  it('does NOT mutate process.env', () => {
    withMockEnv({
      ANTHROPIC_API_KEY: 'sk-mutated-test',
      PATH: '/usr/bin',
    }, () => {
      buildSanitizedSpawnEnv({});
      // process.env.ANTHROPIC_API_KEY は残っているはず
      assert.equal(process.env.ANTHROPIC_API_KEY, 'sk-mutated-test');
    });
  });

  it('allows sanitizeBillingLeak=false to disable removal (escape hatch)', () => {
    withMockEnv({
      ANTHROPIC_API_KEY: 'sk-keep',
    }, () => {
      const env = buildSanitizedSpawnEnv({ sanitizeBillingLeak: false });
      assert.equal(env.ANTHROPIC_API_KEY, 'sk-keep');
      assert.equal(env.__removedKeys.length, 0);
    });
  });
});

describe('buildSanitizedSpawnEnv — provider-home redirection', () => {
  // 一時 provider-home を作るヘルパー
  function makeTempProviderHome(withCredentials) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sales-claw-test-home-'));
    if (withCredentials) {
      const claudeDir = path.join(dir, '.claude');
      fs.mkdirSync(claudeDir, { recursive: true });
      fs.writeFileSync(path.join(claudeDir, 'credentials.json'), '{"subscriptionType":"max"}');
    }
    return dir;
  }
  function cleanup(dir) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }

  it('overrides HOME/USERPROFILE when credentials.json exists', () => {
    const home = makeTempProviderHome(true);
    try {
      withMockEnv({
        HOME: '/original/home',
        USERPROFILE: 'C:\\Users\\Original',
      }, () => {
        const env = buildSanitizedSpawnEnv({
          providerId: 'claude',
          providerHomeDir: home,
        });
        assert.equal(env.HOME, home);
        assert.equal(env.USERPROFILE, home);
        assert.equal(env.__homeOverridden, true);
      });
    } finally {
      cleanup(home);
    }
  });

  it('skips HOME override when credentials.json missing (default)', () => {
    const home = makeTempProviderHome(false);
    try {
      withMockEnv({
        HOME: '/original/home',
        USERPROFILE: 'C:\\Users\\Original',
      }, () => {
        const env = buildSanitizedSpawnEnv({
          providerId: 'claude',
          providerHomeDir: home,
        });
        assert.equal(env.HOME, '/original/home');
        assert.equal(env.USERPROFILE, 'C:\\Users\\Original');
        assert.equal(env.__homeOverridden, false);
      });
    } finally {
      cleanup(home);
    }
  });

  it('forces HOME override when skipHomeOverrideIfNoCredentials=false', () => {
    const home = makeTempProviderHome(false);
    try {
      withMockEnv({
        HOME: '/original/home',
      }, () => {
        const env = buildSanitizedSpawnEnv({
          providerId: 'claude',
          providerHomeDir: home,
          skipHomeOverrideIfNoCredentials: false,
        });
        assert.equal(env.HOME, home);
        assert.equal(env.__homeOverridden, true);
      });
    } finally {
      cleanup(home);
    }
  });

  it('does NOT touch HOME when providerHomeDir not specified', () => {
    withMockEnv({
      HOME: '/original/home',
      USERPROFILE: 'C:\\Users\\Original',
    }, () => {
      const env = buildSanitizedSpawnEnv({});
      assert.equal(env.HOME, '/original/home');
      assert.equal(env.USERPROFILE, 'C:\\Users\\Original');
      assert.equal(env.__homeOverridden, false);
    });
  });
});

describe('buildSanitizedSpawnEnv — extraEnv 合成', () => {
  it('merges extraEnv on top of process.env', () => {
    withMockEnv({
      PATH: '/usr/bin',
    }, () => {
      const env = buildSanitizedSpawnEnv({
        extraEnv: {
          ELECTRON_RUN_AS_NODE: '1',
          CUSTOM_FLAG: 'on',
        },
      });
      assert.equal(env.ELECTRON_RUN_AS_NODE, '1');
      assert.equal(env.CUSTOM_FLAG, 'on');
      assert.equal(env.PATH, '/usr/bin');
    });
  });

  it('extraEnv 経由の billing-leak key 復活は禁止される (defense in depth)', () => {
    withMockEnv({
      ANTHROPIC_API_KEY: 'sk-removed',
    }, () => {
      const env = buildSanitizedSpawnEnv({
        extraEnv: { ANTHROPIC_API_KEY: 'sk-attempted-restore' },
      });
      // サニタイズで消したあと、extraEnv からの復活はブロックされる
      assert.equal(env.ANTHROPIC_API_KEY, undefined);
    });
  });

  it('escape hatch: sanitizeBillingLeak:false なら extraEnv 経由でもセット可', () => {
    const env = buildSanitizedSpawnEnv({
      sanitizeBillingLeak: false,
      extraEnv: { ANTHROPIC_API_KEY: 'sk-intentional' },
    });
    assert.equal(env.ANTHROPIC_API_KEY, 'sk-intentional');
  });

  it('skips undefined values in extraEnv', () => {
    const env = buildSanitizedSpawnEnv({
      extraEnv: { DEFINED: 'yes', UNDEFINED: undefined },
    });
    assert.equal(env.DEFINED, 'yes');
    assert.equal(env.UNDEFINED, undefined);
  });
});

describe('stripSanitizerMeta', () => {
  it('removes __removedKeys and __homeOverridden', () => {
    const env = buildSanitizedSpawnEnv({});
    const stripped = stripSanitizerMeta(env);
    assert.equal(stripped.__removedKeys, undefined);
    assert.equal(stripped.__homeOverridden, undefined);
  });

  it('preserves all other keys', () => {
    withMockEnv({ PATH: '/usr/bin', LANG: 'C' }, () => {
      const env = buildSanitizedSpawnEnv({});
      const stripped = stripSanitizerMeta(env);
      assert.equal(stripped.PATH, '/usr/bin');
      assert.equal(stripped.LANG, 'C');
    });
  });
});
