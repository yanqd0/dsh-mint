/**
 * dsh-mint 的浏览器半边：注册右侧栏两个并列的 tab 类型（`mint` 面板与 plan DAG）、各自的 body，
 * 以及 DAG tab 的自动打开探针；两者都像自带的文件树、终端一样从 tab 条的新增控件进入。
 *
 * 入口由 `scripts/build-client.mjs` 包成 `window.__ModuleLoader__.load({ id, factory })`：壳的冻结
 * 模块表之外的一切必须 `external`，故只能 import React 与 `@deepseek-ai/dsh-client-ui-primitives`
 * （`dsh.client.inject` 只排别的插件 bundle 的顺序，顶不了未声明的模块请求）。
 */
import { IconChecklistOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives';

import { DagBody } from './DagBody.js';
import { MintBody } from './MintBody.js';
import { createApi } from './api.js';
import { EN, NS, ZH, createTranslator } from './copy.js';
import type { CopyTranslate } from './copy.js';
import { DAG_TAB_KIND, startDagAutoOpen } from './dag-open.js';
import type { ClientContextLike, MintApiLike, TabDefinitionLike } from './types.js';

/**
 * `apply` 之前要等的客户端服务。在此声明正是 bundle 在每种组合里都安全的原因：某个服务始终不出现
 * （比如没有右侧栏的宿主）时，插件停在 pending 而不是抛错。
 */
export const inject = ['slots', 'locale', 'sidebarRightTabs', 'sidebarRight'];

/** This implementation's identity in the tab system, and the body seat's key. */
export const TAB_ID = '@yanqd0/dsh-mint';

/** The tab type's discriminator: what `openTab('mint')` names. */
export const TAB_KIND = 'mint';

/** The guide entry's position: after the file tree (10) and the terminal (20). */
export const GUIDE_ORDER = 30;

/** The DAG tab type's identity, distinct from the tab kind it opens by. */
export const DAG_TAB_ID = '@yanqd0/dsh-mint:plan-dag';

/**
 * DAG tab 的判别值，从探针模块再导出：一处定义两处消费（`apply` 注册类型、`dag-open.ts` 打开它）——
 * 写成两个字面量只会静默失效，不会报错。
 */
export { DAG_TAB_KIND };

/** The DAG guide entry's position: after the mint entry (30). */
export const DAG_GUIDE_ORDER = 40;

/**
 * 替插件生命周期持有一次注册。真实 client ctx 上 `effect` 恒在；兜底让精简上下文（以及单测替身）
 * 仍能工作，代价是没有释放。
 */
function own(ctx: ClientContextLike, callback: () => unknown, label: string): void {
  if (ctx.effect !== undefined) {
    ctx.effect(callback, label);
    return;
  }
  callback();
}

/**
 * mint 面板的 tab 类型声明。`t`（copy 座位）每次投影时重读，故切换语言无需重新注册。
 */
export function mintTabDefinition(t: CopyTranslate): TabDefinitionLike {
  return {
    id: TAB_ID,
    kind: TAB_KIND,
    priority: 'builtin',
    title: () => t('type.label'),
    guide: [
      {
        id: 'mint',
        order: GUIDE_ORDER,
        title: () => t('guide.title'),
        description: () => t('guide.description'),
        icon: IconChecklistOutlineRegular,
      },
    ],
  };
}

/**
 * DAG tab 的静态声明。它是第二个*页*类型而非第一个的模式：同样没有 `patterns`，故按 kind 打开
 * （这正是它每会话唯一、自动打开探针可以反复 `openTab` 而不叠 tab 的原因），guide 位置排在 mint 面板之后。
 */
export function dagTabDefinition(t: CopyTranslate): TabDefinitionLike {
  return {
    id: DAG_TAB_ID,
    kind: DAG_TAB_KIND,
    priority: 'builtin',
    title: () => t('dag.type.label'),
    guide: [
      {
        id: DAG_TAB_KIND,
        order: DAG_GUIDE_ORDER,
        title: () => t('dag.guide.title'),
        description: () => t('dag.guide.description'),
      },
    ],
  };
}

/**
 * DAG body 的注入 props。抽出后 `apply` 读起来就是那串注册，两个 body 的同形也集中可见。
 */
function dagInject(t: CopyTranslate): (sessionId: string) => Record<string, unknown> {
  return (sessionId): { api: MintApiLike; copy: CopyTranslate } => ({
    api: createApi({ sessionId }),
    copy: t,
  });
}

export function apply(ctx: ClientContextLike): void {
  const t = createTranslator(ctx.locale.bind(NS));

  // 两个内置 locale 都带真词典：仓外命名空间只能注册单 locale 形式（`LocaleServiceLike.register`），
  // 而 `EN` 在编译期穷尽 `ZH` 的 key，故哪个 locale 都注册不出残缺词典。
  own(ctx, () => ctx.locale.register(NS, 'zh', { ...ZH }), 'dsh-mint: zh copy');
  own(ctx, () => ctx.locale.register(NS, 'en', { ...EN }), 'dsh-mint: en copy');

  own(ctx, () => ctx.sidebarRightTabs.register(mintTabDefinition(t)), 'dsh-mint: tab type');
  own(ctx, () => ctx.sidebarRightTabs.register(dagTabDefinition(t)), 'dsh-mint: dag tab type');

  own(
    ctx,
    () =>
      ctx.slots.inject('sidebar.right.pane.tab', () =>
        ctx.slots.register(
          {
            name: 'sidebar.right.pane.tab',
            key: TAB_ID,
            locale: NS,
            // `locale: NS` gives the framework's `t` seat to the body; the panel
            // uses this injected seat instead, whose keys are the checked
            // `CopyKey` union rather than the framework's open string domain.
            inject: (sessionId): { api: MintApiLike; copy: CopyTranslate } => ({
              api: createApi({ sessionId }),
              copy: t,
            }),
          },
          MintBody
        )
      ),
    'dsh-mint: tab body'
  );

  own(
    ctx,
    () =>
      ctx.slots.inject('sidebar.right.pane.tab', () =>
        ctx.slots.register(
          { name: 'sidebar.right.pane.tab', key: DAG_TAB_ID, locale: NS, inject: dagInject(t) },
          DagBody
        )
      ),
    'dsh-mint: dag tab body'
  );

  // Auto-open needs a real page to watch: the prober owns a `setInterval`, and a
  // Node test run (or any host without the sidebar service) must not leak one.
  const sidebarRight = ctx.sidebarRight;
  if (sidebarRight !== undefined && typeof document !== 'undefined') {
    own(
      ctx,
      () =>
        startDagAutoOpen(
          { sidebarRight, apiFor: (sessionId) => createApi({ sessionId }) },
          { visible: () => document.visibilityState !== 'hidden' }
        ),
      'dsh-mint: dag auto-open'
    );
  }
}
