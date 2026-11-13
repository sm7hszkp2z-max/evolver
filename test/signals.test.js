const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { extractSignals, normalizeCommand, pickErrorSignatureLine } = require('../src/gep/signals');

const emptyInput = {
  recentSessionTranscript: '',
  todayLog: '',
  memorySnippet: '',
  userSnippet: '',
  recentEvents: [],
};

function hasSignal(signals, name) {
  return Array.isArray(signals) && signals.some(s => String(s).startsWith(name));
}

function getSignalExtra(signals, name) {
  const s = Array.isArray(signals) ? signals.find(x => String(x).startsWith(name + ':')) : undefined;
  if (!s) return undefined;
  const i = String(s).indexOf(':');
  return i === -1 ? '' : String(s).slice(i + 1).trim();
}

describe('extractSignals -- user_feature_request (4 languages)', () => {
  it('recognizes English feature request', () => {
    const r = extractSignals({
      ...emptyInput,
      userSnippet: 'Please add a dark mode toggle to the settings page.',
    });
    assert.ok(hasSignal(r, 'user_feature_request'), 'expected user_feature_request in ' + JSON.stringify(r));
  });

  it('recognizes Simplified Chinese feature request', () => {
    const r = extractSignals({
      ...emptyInput,
      userSnippet: '加个支付模块，要支持微信和支付宝。',
    });
    assert.ok(hasSignal(r, 'user_feature_request'), 'expected user_feature_request in ' + JSON.stringify(r));
  });

  it('recognizes Traditional Chinese feature request', () => {
    const r = extractSignals({
      ...emptyInput,
      userSnippet: '請加一個匯出報表的功能，要支援 PDF。',
    });
    assert.ok(hasSignal(r, 'user_feature_request'), 'expected user_feature_request in ' + JSON.stringify(r));
  });

  it('recognizes Japanese feature request', () => {
    const r = extractSignals({
      ...emptyInput,
      userSnippet: 'ダークモードのトグルを追加してほしいです。',
    });
    assert.ok(hasSignal(r, 'user_feature_request'), 'expected user_feature_request in ' + JSON.stringify(r));
  });

  it('user_feature_request signal carries snippet', () => {
    const r = extractSignals({
      ...emptyInput,
      userSnippet: 'Please add a dark mode toggle to the settings page.',
    });
    const extra = getSignalExtra(r, 'user_feature_request');
    assert.ok(extra !== undefined, 'expected user_feature_request:extra form');
    assert.ok(extra.length > 0, 'extra should not be empty');
    assert.ok(extra.toLowerCase().includes('dark') || extra.includes('toggle') || extra.includes('add'), 'extra should reflect request content');
  });
});

describe('extractSignals -- user_improvement_suggestion (4 languages)', () => {
  it('recognizes English improvement suggestion', () => {
    const r = extractSignals({
      ...emptyInput,
      userSnippet: 'The UI could be better; we should simplify the onboarding flow.',
    });
    assert.ok(hasSignal(r, 'user_improvement_suggestion'), 'expected user_improvement_suggestion in ' + JSON.stringify(r));
  });

  it('recognizes Simplified Chinese improvement suggestion', () => {
    const r = extractSignals({
      ...emptyInput,
      userSnippet: '改进一下登录流程，优化一下性能。',
    });
    assert.ok(hasSignal(r, 'user_improvement_suggestion'), 'expected user_improvement_suggestion in ' + JSON.stringify(r));
  });

  it('recognizes Traditional Chinese improvement suggestion', () => {
    const r = extractSignals({
      ...emptyInput,
      userSnippet: '建議改進匯出速度，優化一下介面。',
    });
    assert.ok(hasSignal(r, 'user_improvement_suggestion'), 'expected user_improvement_suggestion in ' + JSON.stringify(r));
  });

  it('recognizes Japanese improvement suggestion', () => {
    const r = extractSignals({
      ...emptyInput,
      userSnippet: 'ログインの流れを改善してほしい。',
    });
    assert.ok(hasSignal(r, 'user_improvement_suggestion'), 'expected user_improvement_suggestion in ' + JSON.stringify(r));
  });

  it('user_improvement_suggestion signal carries snippet', () => {
    const r = extractSignals({
      ...emptyInput,
      userSnippet: 'We should refactor the payment module and simplify the API.',
    });
    const extra = getSignalExtra(r, 'user_improvement_suggestion');
    assert.ok(extra !== undefined, 'expected user_improvement_suggestion:extra form');
    assert.ok(extra.length > 0, 'extra should not be empty');
  });
});

describe('extractSignals -- edge cases (snippet length, empty, punctuation)', () => {
  it('long snippet truncated to 200 chars', () => {
    const long = '我想让系统支持批量导入用户、导出报表、自定义工作流、多语言切换、主题切换、权限组、审计日志、Webhook 通知、API 限流、缓存策略配置、数据库备份恢复、灰度发布、A/B 测试、埋点统计、性能监控、告警规则、工单流转、知识库搜索、智能推荐、以及一大堆其他功能以便我们能够更好地管理业务。';
    const r = extractSignals({ ...emptyInput, userSnippet: long });
    assert.ok(hasSignal(r, 'user_feature_request'), 'expected user_feature_request');
    const extra = getSignalExtra(r, 'user_feature_request');
    assert.ok(extra !== undefined && extra.length > 0, 'extra should be present');
    assert.ok(extra.length <= 200, 'snippet must be truncated to 200 chars, got ' + extra.length);
  });

  it('short snippet works', () => {
    const r = extractSignals({ ...emptyInput, userSnippet: '我想加一个导出 Excel 的功能。' });
    assert.ok(hasSignal(r, 'user_feature_request'));
    const extra = getSignalExtra(r, 'user_feature_request');
    assert.ok(extra !== undefined && extra.length > 0);
  });

  it('bare "我想。" still triggers', () => {
    const r = extractSignals({ ...emptyInput, userSnippet: '我想。' });
    assert.ok(hasSignal(r, 'user_feature_request'), 'expected user_feature_request for 我想。');
  });

  it('bare "我想" without punctuation still triggers', () => {
    const r = extractSignals({ ...emptyInput, userSnippet: '我想' });
    assert.ok(hasSignal(r, 'user_feature_request'));
  });

  it('empty userSnippet does not produce feature/improvement', () => {
    const r = extractSignals({ ...emptyInput, userSnippet: '' });
    const hasFeat = hasSignal(r, 'user_feature_request');
    const hasImp = hasSignal(r, 'user_improvement_suggestion');
    assert.ok(!hasFeat && !hasImp, 'empty userSnippet should not yield feature/improvement from user input');
  });

  it('whitespace/punctuation only does not match', () => {
    const r = extractSignals({ ...emptyInput, userSnippet: '   \n\t  。，、  \n' });
    assert.ok(!hasSignal(r, 'user_feature_request'), 'whitespace/punctuation only should not match');
    assert.ok(!hasSignal(r, 'user_improvement_suggestion'));
  });

  it('English "I want" long snippet truncated', () => {
    const long = 'I want to add a feature that allows users to export data in CSV and Excel formats, with custom column mapping, date range filters, scheduled exports, email delivery, and integration with our analytics pipeline so that we can reduce manual reporting work. This is critical for Q2.';
    const r = extractSignals({ ...emptyInput, userSnippet: long });
    assert.ok(hasSignal(r, 'user_feature_request'));
    const extra = getSignalExtra(r, 'user_feature_request');
    assert.ok(extra === undefined || extra.length <= 200, 'snippet if present should be <= 200');
  });

  it('improvement snippet truncated to 200', () => {
    const long = '改进一下登录流程：首先支持扫码登录、然后记住设备、然后支持多因素认证、然后审计日志、然后限流防刷、然后国际化提示、然后无障碍优化、然后性能优化、然后安全加固、然后文档补全。';
    const r = extractSignals({ ...emptyInput, userSnippet: long });
    assert.ok(hasSignal(r, 'user_improvement_suggestion'));
    const extra = getSignalExtra(r, 'user_improvement_suggestion');
    assert.ok(extra !== undefined && extra.length > 0);
    assert.ok(extra.length <= 200, 'improvement snippet <= 200, got ' + extra.length);
  });

  it('mixed sentences: feature request detected with snippet', () => {
    const r = extractSignals({
      ...emptyInput,
      userSnippet: '加个支付模块，要支持微信和支付宝。另外昨天那个 bug 修了吗？',
    });
    assert.ok(hasSignal(r, 'user_feature_request'));
    const extra = getSignalExtra(r, 'user_feature_request');
    assert.ok(extra !== undefined && extra.length > 0);
  });

  it('newlines and tabs in text: regex matches and normalizes', () => {
    const r = extractSignals({
      ...emptyInput,
      userSnippet: '我想\n加一个\t导出\n报表的功能。',
    });
    assert.ok(hasSignal(r, 'user_feature_request'));
    const extra = getSignalExtra(r, 'user_feature_request');
    assert.ok(extra !== undefined);
    assert.ok(!/\n/.test(extra) || extra.length <= 200, 'snippet should be normalized');
  });

  it('"我想" in middle of paragraph still triggers', () => {
    const r = extractSignals({
      ...emptyInput,
      userSnippet: '前面是一些背景说明。我想加一个暗色模式开关，方便夜间使用。',
    });
    assert.ok(hasSignal(r, 'user_feature_request'));
    const extra = getSignalExtra(r, 'user_feature_request');
    assert.ok(extra !== undefined && extra.length > 0);
  });

  it('pure punctuation does not trigger', () => {
    const r = extractSignals({ ...emptyInput, userSnippet: '。。。。' });
    assert.ok(!hasSignal(r, 'user_feature_request'));
    assert.ok(!hasSignal(r, 'user_improvement_suggestion'));
  });

  it('both feature_request and improvement_suggestion carry snippets', () => {
    const r = extractSignals({
      ...emptyInput,
      userSnippet: '加个支付模块。另外改进一下登录流程，简化步骤。',
    });
    assert.ok(hasSignal(r, 'user_feature_request'));
    assert.ok(hasSignal(r, 'user_improvement_suggestion'));
    assert.ok(getSignalExtra(r, 'user_feature_request'));
    assert.ok(getSignalExtra(r, 'user_improvement_suggestion'));
  });
});

describe('extractSignals -- tool usage measures repetition, not volume', () => {
  function transcriptOf(commands) {
    return commands
      .map(c => '**ASSISTANT**: working [TOOL: exec] [CMD: ' + c + ']')
      .join('\n');
  }

  it('N distinct exec calls do not produce repeated_tool_usage:exec', () => {
    const commands = [
      'ls -la /home/ralf618/evolver',
      'git status --short',
      'cat package.json',
      'df -h /tmp',
      'free -m',
      'ps aux --sort=-rss',
      'uptime',
      'who -a',
      'dmesg | tail -20',
      'journalctl -n 50 --no-pager',
      'systemctl --user list-units',
      'lsblk -f',
    ];
    const r = extractSignals({ ...emptyInput, recentSessionTranscript: transcriptOf(commands) });
    assert.ok(
      !hasSignal(r, 'repeated_tool_usage:exec'),
      'distinct commands must not look like repetition: ' + JSON.stringify(r)
    );
  });

  it('the same exec command repeated 3 times produces repeated_tool_usage:exec', () => {
    const commands = ['cat /tmp/scratch.json', 'cat /tmp/scratch.json', 'cat /tmp/scratch.json'];
    const r = extractSignals({ ...emptyInput, recentSessionTranscript: transcriptOf(commands) });
    assert.ok(
      hasSignal(r, 'repeated_tool_usage:exec'),
      'expected repeated_tool_usage:exec in ' + JSON.stringify(r)
    );
  });

  it('two repetitions of the same command are not enough', () => {
    const commands = ['cat /tmp/scratch.json', 'cat /tmp/scratch.json'];
    const r = extractSignals({ ...emptyInput, recentSessionTranscript: transcriptOf(commands) });
    assert.ok(
      !hasSignal(r, 'repeated_tool_usage:exec'),
      'expected no repeated_tool_usage:exec in ' + JSON.stringify(r)
    );
  });

  it('volatile parts are normalized before commands are compared', () => {
    assert.equal(
      normalizeCommand('tail -n 100 /var/log/x.log'),
      normalizeCommand('tail -n 200 /var/log/x.log')
    );
    assert.notEqual(
      normalizeCommand('cat /tmp/dir0'),
      normalizeCommand('cat /tmp/dir1')
    );
  });

  it('an enumeration of different targets is not a repetition', () => {
    const commands = ['sleep 5', 'sleep 10', 'sleep 15'];
    const r = extractSignals({ ...emptyInput, recentSessionTranscript: transcriptOf(commands) });
    assert.ok(
      !hasSignal(r, 'repeated_tool_usage:exec'),
      'expected no repeated_tool_usage:exec in ' + JSON.stringify(r)
    );
  });
});

describe('extractSignals -- perf_bottleneck needs an incident, not a config value', () => {
  it('a timeout configuration value alone does not produce perf_bottleneck', () => {
    const r = extractSignals({
      ...emptyInput,
      todayLog: 'DB 回读确认：enabled=1、model/timeout=1800/message 均未受影响。',
    });
    assert.ok(
      !hasSignal(r, 'perf_bottleneck'),
      'config timeout must not fire perf_bottleneck: ' + JSON.stringify(r)
    );
  });

  it('--timeout-seconds alone does not produce perf_bottleneck', () => {
    const r = extractSignals({
      ...emptyInput,
      todayLog: 'widen it: openclaw cron edit <jobId> --timeout-seconds 1800',
    });
    assert.ok(
      !hasSignal(r, 'perf_bottleneck'),
      'config timeout must not fire perf_bottleneck: ' + JSON.stringify(r)
    );
  });

  it('a field name that merely mentions timeout does not produce perf_bottleneck', () => {
    const r = extractSignals({
      ...emptyInput,
      todayLog: 'lastErrorReason=timeout timeoutSeconds=1800',
    });
    assert.ok(
      !hasSignal(r, 'perf_bottleneck'),
      'field names must not fire perf_bottleneck: ' + JSON.stringify(r)
    );
  });

  it('a real timeout incident still produces perf_bottleneck', () => {
    const r = extractSignals({
      ...emptyInput,
      todayLog:
        'lastErrorReason=timeout lastDiagnostics.summary="cron: job execution timed out (last phase: model-call-started)"',
    });
    assert.ok(
      hasSignal(r, 'perf_bottleneck'),
      'expected perf_bottleneck in ' + JSON.stringify(r)
    );
  });

  it('other incident phrasings still produce perf_bottleneck', () => {
    const phrases = [
      'the worker was OOM killed',
      'the process ran out of memory',
      'the query took too long',
      'CPU usage above 95 percent',
      'latency spike on the api',
    ];
    for (const phrase of phrases) {
      const r = extractSignals({ ...emptyInput, todayLog: phrase });
      assert.ok(hasSignal(r, 'perf_bottleneck'), 'expected perf_bottleneck for: ' + phrase);
    }
  });
});

describe('pickErrorSignatureLine -- a success report is not an error signature', () => {
  const successReport =
    'user**: exec completed (quick-bl, code 0) :: now=07:20:01 条目: receipt df7378b2 running 07:18:48 ' +
    '- receipt 196f6528 error 07:12:55 07:16:32 reuters status error| delivery not-delivered| errs 2';

  it('does not pick a successful exec report that embeds another component status error', () => {
    assert.equal(pickErrorSignatureLine([successReport]), null);
  });

  it('does not pick a short success report with "status error" inside', () => {
    assert.equal(
      pickErrorSignatureLine([
        'user**: exec completed (quick-bl, code 0) :: reuters status error| delivery not-delivered| errs 2'
      ]),
      null
    );
  });

  it('still picks a genuine "error:" failure line', () => {
    assert.equal(pickErrorSignatureLine(['error: cannot read file']), 'error: cannot read file');
  });

  it('still picks a genuine bracketed error line', () => {
    const line = '[error] TypeError: x is not a function';
    assert.ok(pickErrorSignatureLine([line]), 'a real error must still be detected');
  });

  it('still picks a genuine "status error" failure line', () => {
    const line = 'news-collect-reuters: status error';
    assert.ok(pickErrorSignatureLine([line]), 'a real status error must still be detected');
  });

  it('keeps a direct error statement even inside a success report', () => {
    const line = 'exec completed (code 0) but [error] TypeError: x is not a function';
    assert.ok(pickErrorSignatureLine([line]), 'direct error statements must survive');
  });

  it('does not pick a success report that only contains a weak error marker', () => {
    assert.equal(pickErrorSignatureLine(['exec completed (code 0) 错误: 0']), null);
  });
});
