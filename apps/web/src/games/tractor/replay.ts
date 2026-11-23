import type { Card } from '../../../../../packages/engine/src/core/cards';
import type { Play, TractorView } from '../../../../../packages/engine/src/games/tractor';
import {
  publicKnowledge,
  strategicPlay,
  type DecisionReport,
} from '../../../../../packages/engine/src/games/tractor/strategy';
const cards = (cs: Card[]) => cs.map((c) => ({ id: c.id, suit: c.suit, rank: c.rank }));
const plays = (ps: Play[]) => ps.map((p) => ({ seat: p.seat, cards: cards(p.cards) }));
/** No access to a Table, session state, bot view, transport, seed or hidden hands. */
export class SafeTractorReplay {
  private round = -1;
  private seat: number | null = null;
  private signature = '';
  private sequence = 0;
  private truncated = false;
  private steps: object[] = [];
  private publicHistory: ReturnType<typeof plays>[] = [];
  private previousPhase = '';
  private previousDealt = -1;
  observe(v: TractorView) {
    const restarted =
      v.phase === 'dealing' && (this.previousPhase !== 'dealing' || v.dealt < this.previousDealt);
    this.previousPhase = v.phase;
    this.previousDealt = v.dealt;
    if (v.round !== this.round || v.seat !== this.seat || restarted) {
      this.round = v.round;
      this.seat = v.seat;
      this.steps = [];
      this.sequence = 0;
      this.signature = '';
      this.truncated = false;
    }
    this.publicHistory = (v.playedHistory ?? []).map(plays);
    const snapshot = {
      seat: v.seat,
      phase: v.phase,
      turn: v.turn,
      dealer: v.dealer,
      round: v.round,
      level: v.level,
      levels: [...v.levels],
      trump: v.trump,
      points: v.points,
      dealt: v.dealt,
      handCounts: [...v.handCounts],
      ownHand: cards(v.hand),
      visibleKitty: cards(v.kitty),
      trick: plays(v.trick),
      lastTrick: plays(v.lastTrick),
      announcements: plays(v.publicReveals ?? v.declarationHistory ?? []),
      bid: v.bid ? { seat: v.bid.seat, strength: v.bid.strength, cards: cards(v.bid.cards) } : null,
      throwFailure: v.throwFailure
        ? {
            seat: v.throwFailure.seat,
            challenger: v.throwFailure.challenger,
            attempted: cards(v.throwFailure.attempted),
            forced: cards(v.throwFailure.forced),
            penalty: v.throwFailure.penalty,
          }
        : null,
      awaitingDeclaration: v.awaitingDeclaration,
      result: v.result,
    };
    const signature = JSON.stringify(snapshot);
    if (signature === this.signature) return;
    this.signature = signature;
    let decision: DecisionReport | null = null;
    if (v.phase === 'play' && v.seat !== null && v.turn === v.seat && v.hand.length)
      strategicPlay(v, (d) => {
        decision = d;
      });
    // Candidate scores are ONLY counterfactual evaluation of the viewer's own hand.
    // Opponent actions remain public observations with NO bot-private explanation.
    const knowledge = publicKnowledge(v);
    this.steps.push({
      step: ++this.sequence,
      ...snapshot,
      publicVoids: knowledge.voids.map((x) => [...x]),
      ownDecision: decision,
      reasonScope: 'viewer-own public observation only; not opponent rationale',
    });
    while (this.steps.length > 240 || this.json().length * 3 > 524288) {
      this.steps.shift();
      this.truncated = true;
    }
  }
  json() {
    return JSON.stringify(
      {
        schema: 'deskpark.tractor.public-replay.v2',
        game: 'tractor',
        gameVersion: 'deskpark-tractor-house-v2',
        strategyVersion: 'adaptive-v2',
        visibility:
          'partial: public observations plus viewer own hand/allowed kitty; no concealed opponents, seed or bot-private rationale',
        coverage:
          'observed client frames only; reconnects/background tabs may omit intermediate events',
        round: this.round,
        seat: this.seat,
        truncated: this.truncated,
        publicActions: this.publicHistory,
        steps: this.steps,
      },
      null,
      2,
    );
  }
}
/** iOS12-compatible Blob anchor, with selectable JSON available independently. */
export function downloadReplay(recorder: SafeTractorReplay) {
  const text = recorder.json();
  const blob = new Blob([text], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `tractor-v2-round-${JSON.parse(text).round}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  window.setTimeout(() => URL.revokeObjectURL(url), 60000);
  return text;
}
