import { expect } from 'vitest';
import type { Ctx } from '../../server/domain/ctx';
import { getFinding, getRawEvidence, listFindings, listNativeRuns, queueNativeAnalysis } from '../../server/domain/analysis';
import { drain } from '../../workers/main';
import type { WorkerEnv } from '../../workers/runtime';

type Finding = Awaited<ReturnType<typeof listFindings>>['items'][number];

export async function gatherIntcalcEvidence(c: Ctx, env: WorkerEnv, sourceId: string, sha256: string, report: Record<string, unknown>) {
  const deepRuns: Record<string, unknown>[] = [];
  report.deep_runs = deepRuns;
  const indexStart = performance.now();
  const index = await queueNativeAnalysis(c, sourceId, { kind: 'index' });
  await drain(env, ['native_index']);
  const indexRun = (await listNativeRuns(c, sourceId)).runs.find(run => (run as { id: string }).id === index.run_id);
  report.index = { wall_ms: Math.round(performance.now() - indexStart), run: indexRun };
  expect(indexRun).toMatchObject({ status: 'succeeded', outcome: 'complete' });

  const functions: Finding[] = [];
  let cursor: string | undefined;
  do {
    const page = await listFindings(c, sourceId, { runId: index.run_id, kind: 'function', q: '', limit: 100, cursor });
    functions.push(...page.items.filter(fn => fn.address && fn.name && fn.attributes.thunk !== true));
    cursor = page.next_cursor ?? undefined;
  } while (cursor);
  const byName = new Map(functions.map(fn => [fn.name!, fn]));
  const entry = byName.get('entry') ?? byName.get('_start');
  expect(entry, 'the stripped inventory must identify a startup entry').toBeDefined();

  async function decompile(fn: Finding, role: string) {
    const measurement: Record<string, unknown> = { role, function: fn.name, address: fn.address, finding_id: fn.id };
    deepRuns.push(measurement);
    const start = performance.now();
    const deep = await queueNativeAnalysis(c, sourceId, { kind: 'deep_function', params: { address: fn.address! } });
    await drain(env, ['native_deep_function']);
    measurement.wall_ms = Math.round(performance.now() - start);
    const run = (await listNativeRuns(c, sourceId)).runs.find(item => (item as { id: string }).id === deep.run_id);
    measurement.run = run;
    expect(run, String(fn.name)).toMatchObject({ status: 'succeeded', outcome: 'complete' });
    const { items } = await listFindings(c, sourceId, { runId: deep.run_id, kind: 'pseudocode', q: '', limit: 10 });
    expect(items).toHaveLength(1);
    const detail = await getFinding(c, items[0].id);
    expect(detail.provenance.artifact_sha256).toBe(sha256);
    const raw = JSON.parse(await getRawEvidence(c, deep.run_id, detail.provenance.provider_evidence_id));
    expect(raw).toMatchObject({ evidence_id: detail.provenance.provider_evidence_id, subject: { digest: { sha256 } } });
    expect(detail.content).toBeTruthy();
    measurement.pseudocode = detail.content;
    measurement.pseudocode_id = detail.id;
    measurement.provider_evidence_id = detail.provenance.provider_evidence_id;
    return { fn, id: detail.id, content: detail.content! };
  }

  const startup = await decompile(entry!, 'program entry');
  const mainName = /\b__libc_start_main\s*\(\s*(?:\([^()]*\)\s*)*&?([A-Za-z_][\w]*)/.exec(startup.content)?.[1];
  const main = mainName && byName.get(mainName);
  expect(main || undefined, 'resolve the __libc_start_main argument against the stripped index').toBeDefined();
  const workflow = await decompile(main as Finding, 'workflow entry');
  const symbols = [...workflow.content.matchAll(/\b([A-Za-z_][\w]*)\s*\(/g)].map(match => match[1]);
  const callees = [...new Set(symbols)].flatMap(name => {
    const fn = byName.get(name);
    return fn && fn.id !== workflow.fn.id && fn.id !== startup.fn.id ? [fn] : [];
  });

  const hasArithmetic = (content: string) => content.includes('+') && /\/\s*3(?:\.0+)?\b/.test(content);
  const hasParsing = (content: string) => /\bstrto(?:l|ll)\s*\(/.test(content);
  let arithmetic = hasArithmetic(workflow.content) ? workflow : undefined;
  let parser = hasParsing(workflow.content) ? workflow : undefined;
  for (const fn of callees) {
    if (arithmetic && parser) break;
    const focused = await decompile(fn, 'indexed workflow callee');
    if (!arithmetic && hasArithmetic(focused.content)) arithmetic = focused;
    if (!parser && hasParsing(focused.content)) parser = focused;
  }
  expect(arithmetic, 'find add and divide-by-three pseudocode under the indexed workflow').toBeDefined();
  report.selected = {
    name: arithmetic!.fn.name, address: arithmetic!.fn.address, function_finding_id: arithmetic!.fn.id,
    pseudocode_finding_id: arithmetic!.id, workflow: workflow.fn.name, parser: parser?.fn.name ?? null,
    selection: 'Indexed startup entry → first __libc_start_main argument → indexed workflow/local callees → addition and divide by three',
  };
  const citations = (parts: (typeof workflow | undefined)[]) => [...new Set(parts.flatMap(part => part ? [part.fn.id, part.id] : []))];
  return {
    sumScale: citations([workflow, arithmetic]),
    badArgs: citations([workflow, parser]),
    pseudocodeId: arithmetic!.id,
  };
}
