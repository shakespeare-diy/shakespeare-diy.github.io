import { describe, it, expect } from 'vitest';
import { DEFAULT_NPANEL_PROVIDER, migrateDeployProvider } from './deployProviderPresets';

describe('migrateDeployProvider', () => {
  it('turns a Shakespeare Deploy provider into a gateway on the same domain', () => {
    // That host serves those same names out of nsite manifests now, so the
    // deploy button keeps working and lands where it always did.
    const migrated = migrateDeployProvider({
      id: 'shakespeare',
      name: 'Shakespeare Deploy',
      type: 'shakespeare',
      host: 'shakespeare.wtf',
    });

    expect(migrated).toMatchObject({
      id: 'shakespeare',
      name: 'Shakespeare Deploy',
      type: 'npanel',
      domain: 'shakespeare.wtf',
      dashboardHost: DEFAULT_NPANEL_PROVIDER.dashboardHost,
    });
  });

  it('keeps the provider id, so a project still finds its saved deployment', () => {
    const migrated = migrateDeployProvider({ id: 'custom-123', name: 'Mine', type: 'shakespeare' });

    expect(migrated).toMatchObject({ id: 'custom-123', name: 'Mine' });
  });

  it('assumes the default domain when none was saved', () => {
    // `host` was optional and the adapter defaulted it, so an entry without one
    // was never pointing at nothing.
    expect(migrateDeployProvider({ id: 'shakespeare', name: 'Shakespeare', type: 'shakespeare' }))
      .toMatchObject({ domain: 'shakespeare.wtf' });
  });

  it('leaves every other provider exactly as it found it', () => {
    const netlify = { id: 'netlify', name: 'Netlify', type: 'netlify', apiKey: 'token' };

    expect(migrateDeployProvider(netlify)).toBe(netlify);
  });

  it('passes through anything that is not a provider at all', () => {
    // It runs over whatever is in the file, which may be nothing of the sort.
    expect(migrateDeployProvider(null)).toBe(null);
    expect(migrateDeployProvider('nonsense')).toBe('nonsense');
  });
});
