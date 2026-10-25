import { afterEach, describe, expect, it } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { defineComponent, h } from 'vue';
import { createMemoryHistory, createRouter } from 'vue-router';
import PageContainer from '@/components/layout/PageContainer.vue';
import BaseBreadcrumb from '@/components/ui/BaseBreadcrumb.vue';
import CodeBlock from '@/components/ui/CodeBlock.vue';
import KeyValueList from '@/components/ui/KeyValueList.vue';
import PageHeader from '@/components/ui/PageHeader.vue';
import BasePanel from '@/components/ui/BasePanel.vue';
import ProgressBar from '@/components/ui/ProgressBar.vue';
import StatusDot from '@/components/ui/StatusDot.vue';
import BaseTag from '@/components/ui/BaseTag.vue';

let wrapper: VueWrapper | null = null;
afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
});

const router = () =>
  createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/:p(.*)*', component: defineComponent({ render: () => h('div') }) }],
  });

describe('PageContainer', () => {
  it.each([
    ['list', ['p-24', 'gap-16']],
    ['detail', ['px-24', 'pt-20', 'pb-48', 'gap-16']],
    ['system', ['pt-24', 'pb-48', 'gap-28']],
  ] as const)('%s pages use the boards’ padding and gaps', (variant, classes) => {
    wrapper = mount(PageContainer, { props: { variant }, slots: { default: 'x' } });
    expect(wrapper.element.tagName).toBe('MAIN');
    expect(wrapper.classes()).toEqual(
      expect.arrayContaining(['max-w-1440', 'mx-auto', 'max-xl:px-16', ...classes]),
    );
  });

  it('takes another gap', () => {
    wrapper = mount(PageContainer, { props: { variant: 'detail', gap: 14 } });
    expect(wrapper.classes()).toContain('gap-14');
    expect(wrapper.classes()).not.toContain('gap-16');
  });
});

describe('PageHeader and Breadcrumb', () => {
  it('draws the breadcrumb, a mono title, its extras and the actions', async () => {
    const r = router();
    await r.push('/configurations/c1');
    wrapper = mount(PageHeader, {
      global: { plugins: [r] },
      props: {
        title: 'with-skill',
        mono: true,
        breadcrumbs: [{ label: 'Configurations', to: '/configurations' }, { label: 'with-skill' }],
      },
      slots: {
        'title-extra': '<span class="tag">v1 · latest</span>',
        actions: '<a class="btn primary">Edit</a>',
        meta: '<p>Created 23 Oct</p>',
      },
    });
    await flushPromises();
    const crumbs = wrapper.get('nav[aria-label="Breadcrumb"]');
    expect(crumbs.text().replace(/\s+/g, ' ')).toBe('Configurations / with-skill');
    expect(crumbs.get('a').attributes('href')).toBe('/configurations');
    expect(crumbs.get('[aria-current="page"]').text()).toBe('with-skill');
    const h1 = wrapper.get('h1');
    expect(h1.text()).toBe('with-skill');
    expect(h1.classes()).toEqual(expect.arrayContaining(['text-20', 'font-semibold', 'font-mono']));
    expect(wrapper.text()).toContain('v1 · latest');
    expect(wrapper.text()).toContain('Created 23 Oct');
    expect(wrapper.get('a.btn.primary').text()).toBe('Edit');
  });

  it('shows a count beside a list title and centres the actions', () => {
    wrapper = mount(PageHeader, {
      props: { title: 'Configurations', count: '3 configurations' },
      slots: { actions: '<button>New configuration</button>' },
    });
    expect(wrapper.classes()).toContain('items-center');
    expect(wrapper.get('h1 + span').text()).toBe('3 configurations');
    expect(wrapper.find('nav').exists()).toBe(false);
  });

  it('a breadcrumb never links its last item', () => {
    wrapper = mount(BaseBreadcrumb, {
      global: { plugins: [router()] },
      props: {
        items: [
          { label: 'Suites', to: '/suites' },
          { label: 'total_due', to: '/x' },
        ],
      },
    });
    expect(wrapper.findAll('a')).toHaveLength(1);
  });
});

describe('Panel', () => {
  it('is labelled by its header, with the caption and actions on the right', () => {
    wrapper = mount(BasePanel, {
      props: { title: 'Fields', meta: "as written into each run's config.yaml", padding: 'md' },
      slots: { default: '<p>body</p>', actions: '<button>Compare</button>' },
    });
    const heading = wrapper.get('h2');
    expect(heading.text()).toBe('Fields');
    expect(wrapper.attributes('aria-labelledby')).toBe(heading.attributes('id'));
    expect(wrapper.text()).toContain("as written into each run's config.yaml");
    expect(wrapper.get('button').text()).toBe('Compare');
    expect(wrapper.get('p').element.parentElement?.className).toBe('p-16');
    expect(wrapper.classes()).toEqual(
      expect.arrayContaining(['rounded-6', 'border', 'bg-surface']),
    );
  });

  it('is a plain box without a title', () => {
    wrapper = mount(BasePanel, { props: { border: 'strong', as: 'div' }, slots: { default: 'x' } });
    expect(wrapper.element.tagName).toBe('DIV');
    expect(wrapper.attributes('aria-labelledby')).toBeUndefined();
    expect(wrapper.classes()).toContain('border-border-strong');
  });
});

describe('Tag and StatusDot', () => {
  it('a tag is the canvas .tag, mono unless asked', () => {
    wrapper = mount(BaseTag, { slots: { default: 'b72e810' } });
    expect(wrapper.classes()).toContain('tag');
    expect(wrapper.classes()).not.toContain('font-sans');
    wrapper.unmount();
    wrapper = mount(BaseTag, { props: { mono: false, strong: true }, slots: { default: 'v2' } });
    expect(wrapper.classes()).toEqual(expect.arrayContaining(['font-sans', 'font-semibold']));
  });

  it.each([
    ['solid', ['size-6', 'rounded-full', 'bg-pass']],
    ['hollow', ['size-7', 'border-pass', 'bg-transparent']],
    ['pulse', ['animate-live', 'bg-pass']],
  ] as const)('a %s dot', (mode, classes) => {
    wrapper = mount(StatusDot, { props: { tone: 'pass', mode } });
    expect(wrapper.classes()).toEqual(expect.arrayContaining([...classes]));
    expect(wrapper.attributes('aria-hidden')).toBe('true');
  });
});

describe('KeyValueList', () => {
  const items = [
    { key: 'model', label: 'Model', value: 'openai/gpt-6.1-sol', mono: true },
    { key: 'memory', label: 'Memory', value: 'off' },
    { key: 'skills', label: 'Skills', value: null, highlight: true },
  ];

  it('grid: labels and values in two columns, missing values as an en dash', () => {
    wrapper = mount(KeyValueList, { props: { items, labelWidth: 160 } });
    expect(wrapper.element.tagName).toBe('DL');
    expect(wrapper.attributes('style')).toContain('grid-template-columns: 160px minmax(0, 1fr)');
    expect(wrapper.findAll('dt').map((d) => d.text())).toEqual(['Model', 'Memory', 'Skills']);
    const dds = wrapper.findAll('dd');
    expect(dds[0]!.classes()).toContain('font-mono');
    expect(dds[2]!.text()).toBe('–');
    expect(dds[2]!.classes()).toContain('text-text-3');
  });

  it('rows: bordered rows, the highlighted one on accent, no border under the last', () => {
    wrapper = mount(KeyValueList, { props: { items, layout: 'rows' } });
    const rows = wrapper.findAll('dl > div');
    expect(rows).toHaveLength(3);
    expect(rows[0]!.classes()).toContain('border-b');
    expect(rows[2]!.classes()).not.toContain('border-b');
    expect(rows[2]!.classes()).toContain('bg-accent-soft');
  });

  it('inline: pairs on one line; a slot replaces a value', () => {
    wrapper = mount(KeyValueList, {
      props: { items, layout: 'inline' },
      slots: { 'value-memory': '<span class="chip">off</span>' },
    });
    expect(wrapper.classes()).toEqual(expect.arrayContaining(['flex', 'flex-wrap']));
    expect(wrapper.find('[data-key="memory"] .chip').exists()).toBe(true);
  });
});

describe('ProgressBar', () => {
  it('is a labelled progressbar with segments in pipeline order', () => {
    wrapper = mount(ProgressBar, {
      props: {
        max: 120,
        now: 87,
        label: '87 of 120 runs scored',
        height: 12,
        segments: [
          { value: 87, tone: 'pass' },
          { value: 3, tone: 'run', pulse: true },
          { value: 28, tone: 'que', pattern: 'hatch' },
        ],
      },
    });
    expect(wrapper.attributes()).toMatchObject({
      role: 'progressbar',
      'aria-valuemin': '0',
      'aria-valuemax': '120',
      'aria-valuenow': '87',
      'aria-label': '87 of 120 runs scored',
    });
    const segments = wrapper.findAll('[data-testid="progress-segment"]');
    expect(segments[0]!.attributes('style')).toContain('width: 72.5%');
    expect(segments[0]!.classes()).toContain('bg-pass');
    expect(segments[1]!.classes()).toContain('animate-live');
    expect(segments[2]!.attributes('style')).toContain('repeating-linear-gradient');
    expect(wrapper.classes()).toContain('rounded-3');
  });

  it('draws one value and clamps it', () => {
    wrapper = mount(ProgressBar, {
      props: { max: 2, value: 3, tone: 'muted', label: 'Spend', height: 4 },
    });
    const segment = wrapper.get('[data-testid="progress-segment"]');
    expect(segment.attributes('style')).toContain('width: 100%');
    expect(segment.classes()).toContain('bg-text-3');
    expect(wrapper.attributes('aria-valuenow')).toBe('3');
  });
});

describe('CodeBlock', () => {
  it('keeps the text as written and can copy it', () => {
    wrapper = mount(CodeBlock, {
      props: { code: 'model: x\n  provider: nous', copy: true, label: 'config.yaml' },
    });
    const pre = wrapper.get('pre');
    expect(pre.text()).toBe('model: x\n  provider: nous');
    expect(pre.attributes('aria-label')).toBe('config.yaml');
    expect(wrapper.find('button[aria-label="Copy"]').exists()).toBe(true);
  });
});
