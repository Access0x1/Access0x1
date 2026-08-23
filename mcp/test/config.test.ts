import { describe, expect, it } from 'vitest';
import { loadConfig, describeManifestSources } from '../src/config.js';
import { ConfigError } from '../src/errors.js';

describe('loadConfig', () => {
  it('fails fast when no manifest source is configured', () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    expect(() => loadConfig({ ACCESS0X1_SUBGRAPH_URL: 'https://x/y' })).toThrow(ConfigError);
  });

  it('treats a blank env value as unset', () => {
    expect(() => loadConfig({ ACCESS0X1_MANIFEST_PATH: '   ' })).toThrow(ConfigError);
  });

  it('orders sources path-first, then url', () => {
    const cfg = loadConfig({
      ACCESS0X1_MANIFEST_PATH: './m.json',
      ACCESS0X1_MANIFEST_URL: 'https://raw/m.json',
    });
    expect(cfg.manifestSources.map((s) => s.kind)).toEqual(['path', 'url']);
    expect(describeManifestSources(cfg.manifestSources)).toBe('path:./m.json, url:https://raw/m.json');
  });

  it('accepts a url-only manifest source', () => {
    const cfg = loadConfig({ ACCESS0X1_MANIFEST_URL: 'https://raw/m.json' });
    expect(cfg.manifestSources).toEqual([{ kind: 'url', value: 'https://raw/m.json' }]);
  });

  it('leaves optional capabilities dormant (null) when unset', () => {
    const cfg = loadConfig({ ACCESS0X1_MANIFEST_PATH: './m.json' });
    expect(cfg.subgraphUrl).toBeNull();
    expect(cfg.webBaseUrl).toBeNull();
    expect(cfg.agentInternalSecret).toBeNull();
  });

  it('normalizes the web base URL and strips a trailing slash', () => {
    const cfg = loadConfig({
      ACCESS0X1_MANIFEST_PATH: './m.json',
      ACCESS0X1_WEB_BASE_URL: 'https://pay.example.com/',
    });
    expect(cfg.webBaseUrl).toBe('https://pay.example.com');
  });

  it('rejects a malformed web base URL', () => {
    expect(() =>
      loadConfig({ ACCESS0X1_MANIFEST_PATH: './m.json', ACCESS0X1_WEB_BASE_URL: 'not a url' }),
    ).toThrow(ConfigError);
  });

  it('carries the optional caller-auth secret when present', () => {
    const cfg = loadConfig({
      ACCESS0X1_MANIFEST_PATH: './m.json',
      ACCESS0X1_AGENT_INTERNAL_SECRET: 's3cr3t',
    });
    expect(cfg.agentInternalSecret).toBe('s3cr3t');
  });
});
