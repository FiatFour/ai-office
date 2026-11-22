import { describe, expect, it } from 'vitest';
import { modesOf, parseModes } from '../modes.ts';
import { finalStatus, formatLine, judge, type ModeResult, summarize, summaryOk } from '../outcome.ts';

const row = { id: 'mask-empties-env', expect: 'L2', rating: 'stopped', modes: 'C, SC' };

describe('judge', () => {
  it('passes when the observed layers are the ones the row names', () => {
    expect(judge(row, { observed: ['L2'] })).toMatchObject({ status: 'PASS', stop: 'L2' });
  });

  it('fails when a different layer, or no layer, stopped it', () => {
    expect(judge(row, { observed: ['L4'] }).status).toBe('FAIL');
    expect(judge(row, { observed: [] })).toMatchObject({ status: 'FAIL', stop: 'none' });
  });

  it('passes an open row only when nothing stopped it', () => {
    const open = { ...row, expect: 'none', rating: 'open' };
    expect(judge(open, { observed: [] }).status).toBe('PASS');
    expect(judge(open, { observed: ['L2'] }).status).toBe('FAIL');
  });

  it('records not-run as NOT-RUN, but fails a stopped row that was not run', () => {
    expect(judge({ ...row, rating: 'best-effort' }, { notRun: 'needs a model' }).status).toBe('NOT-RUN');
    expect(judge(row, { notRun: 'no docker' }).status).toBe('FAIL');
  });

  it('fails a row rated not-run that ran', () => {
    expect(judge({ ...row, rating: 'not-run', expect: 'none' }, { observed: [] }).status).toBe('FAIL');
  });
});

describe('finalStatus', () => {
  it('turns any canary hit in a caged mode into FAIL and leaves subagents-local to the row', () => {
    expect(finalStatus('cages', 'PASS', 1, 0)).toBe('FAIL');
    expect(finalStatus('subagents-cage', 'PASS', 0, 1)).toBe('FAIL');
    expect(finalStatus('cages', 'PASS', 0, 0)).toBe('PASS');
    expect(finalStatus('subagents-local', 'PASS', 3, 3)).toBe('PASS');
  });
});

const result = (over: Partial<ModeResult>): ModeResult => ({
  id: 'x',
  mode: 'cages',
  status: 'PASS',
  stop: 'L2',
  expected: 'L2',
  rating: 'stopped',
  hits: 0,
  providerUses: 0,
  ms: 5,
  note: '',
  ...over,
});

describe('report lines', () => {
  it('prints one line per task and mode with the stopping layer and the hit count', () => {
    expect(formatLine(result({}))).toBe(
      'PASS cages x stop=L2 expected=L2 rating=stopped canary-hits=0 provider-uses=0 (5 ms)',
    );
  });

  it('fails a caged summary with a hit and accepts a subagents-local one', () => {
    expect(summaryOk(summarize('cages', [result({ hits: 1, status: 'FAIL' })]))).toBe(false);
    expect(summaryOk(summarize('subagents-local', [result({ mode: 'subagents-local', hits: 4 })]))).toBe(true);
    expect(summaryOk(summarize('cages', [result({ status: 'NOT-RUN' })]))).toBe(true);
    expect(summaryOk(summarize('subagents-cage', [result({ mode: 'subagents-cage', providerUses: 1 })]))).toBe(false);
  });
});

describe('modes', () => {
  it('parses all, a list, and refuses an unknown mode', () => {
    expect(parseModes('all')).toHaveLength(3);
    expect(parseModes('cages,subagents-local')).toEqual(['cages', 'subagents-local']);
    expect(() => parseModes('vm')).toThrow('unknown mode');
  });

  it('maps the threat-model mode column', () => {
    expect(modesOf('C, SC, SL')).toEqual(['cages', 'subagents-cage', 'subagents-local']);
    expect(modesOf('SL')).toEqual(['subagents-local']);
  });
});
