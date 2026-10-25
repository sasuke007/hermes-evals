import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import BulkOutcomeBanner from '../BulkOutcomeBanner.vue';

describe('BulkOutcomeBanner', () => {
  it('quotes a failed request and the fields it refused', () => {
    const w = mount(BulkOutcomeBanner, {
      props: {
        outcome: null,
        records: {},
        error: {
          action: 'retry',
          message: 'POST /api/experiments/exp_1/runs/retry → 400 · Validation failed',
          issues: 'runIds: select at most 500 runs',
        },
      },
    });
    const banner = w.get('[data-testid=bulk-error]');
    expect(banner.text()).toContain('Could not retry');
    expect(banner.text()).toContain('→ 400 · Validation failed');
    expect(banner.get('[data-testid=error-banner-hint]').text()).toBe(
      'runIds: select at most 500 runs',
    );
  });
});
