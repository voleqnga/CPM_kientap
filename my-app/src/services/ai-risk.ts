import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, of } from 'rxjs';
import { catchError, map, shareReplay } from 'rxjs/operators';

import { environment } from '../environments/environment';
import { DataService, TODAY } from '../classes/data';
import { Goal } from '../classes/cpn';
import { pickMetricGoals } from '../classes/kpi-math';
import {
  AiGoalInput,
  AiGoalResult,
  AiRiskRequest,
  AiRiskResult,
  CoachingAction,
  RiskLabel,
  ShapFactor,
  Tone
} from '../model/ai-risk.model';

const MIN_SHAP_IMPACT = 0.3;
const MAX_SHAP_FACTORS = 3;
const MAX_P_HIGH = 0.99;

/** Phần trăm hiển thị của p_high: tối đa 99, không bao giờ in "100%". */
export function pHighPercent(p: number): number {
  return Number.isFinite(p) ? Math.min(99, Math.max(0, Math.round(p * 100))) : 0;
}

/* ---- Kiểu thô của response (chỉ dùng nội bộ để mapper nhận cả snake_case và camelCase) ---- */
interface RawShap { feature?: string; label?: string; impact?: number }
interface RawAction { icon?: string; tone?: string; title?: string; detail?: string }
interface RawGoal { name?: string; risk_label?: string; p_high?: number }
interface AiRiskApiResponse {
  employee_code?: string;
  risk_label?: string;
  shap_factors?: RawShap[];
  shapFactors?: RawShap[];   // backend cũ
  feedback?: string;
  actions?: RawAction[];
  worst_goal?: string;
  goals?: RawGoal[];
}

@Injectable({ providedIn: 'root' })
export class AiRiskService {
  private readonly http = inject(HttpClient);
  private readonly data = inject(DataService);

  /** key = employee_code + JSON(goals gửi đi) */
  private readonly cache = new Map<string, Observable<AiRiskResult>>();

  analyze(employeeCode: string, goals: Goal[], audience: 'employee' | 'manager' = 'employee'): Observable<AiRiskResult> {
    const inputs = this.toInputs(goals);
    if (!inputs.length) return of(this.emptyResult(employeeCode));

    const key = `${audience}|${employeeCode}|${JSON.stringify(inputs)}`;
    const cached = this.cache.get(key);
    if (cached) return cached;

    const body: AiRiskRequest = { employee_code: employeeCode, goals: inputs, audience };
    const request$ = this.http.post<AiRiskApiResponse>(environment.aiApiUrl, body).pipe(
      map(raw => this.normalize(employeeCode, raw, this.data.riskOf(goals))),
      catchError(() => {
        this.cache.delete(key); // lỗi thì không cache, lần sau gọi lại được
        return of(this.fallbackResult(employeeCode, goals));
      }),
      shareReplay(1)
    );
    this.cache.set(key, request$);
    return request$;
  }

  clearCache(): void {
    this.cache.clear();
  }

  /* ---------------- nội bộ ---------------- */

  private toInputs(goals: Goal[]): AiGoalInput[] {
    return pickMetricGoals(goals).map(goal => ({
      name: goal.name,
      expected_progress: this.num(this.data.expectedProgress(goal)),
      actual_progress: this.num(this.data.currentProgress(goal)),
      overdue_tasks: this.num(this.data.overdueTasksOf(goal).length),
      days_remaining: this.num(this.data.daysRemaining(goal)),
      total_duration_days: this.num(goal.totalDurationDays),
      overdue_items: this.data.overdueTasksOf(goal).map(task => ({
        name: task.name,
        due_date: task.dueDate,
        days_late: this.num(Math.round((Date.parse(TODAY) - Date.parse(task.dueDate)) / 86400000))
      }))
    }));
  }

  /** Số hữu hạn và >= 0, ngược lại trả 0 */
  private num(value: number): number {
    return Number.isFinite(value) && value >= 0 ? value : 0;
  }

  private emptyResult(code: string): AiRiskResult {
    return { employee_code: code, risk_label: 'Normal', shap_factors: [], feedback: '', actions: [], worst_goal: '', goals: [] };
  }

  private fallbackResult(code: string, goals: Goal[]): AiRiskResult {
    return { ...this.emptyResult(code), risk_label: this.data.riskOf(goals), unavailable: true };
  }

  private asRisk(value: unknown, fallback: RiskLabel): RiskLabel {
    return value === 'High Risk' || value === 'Low Risk' || value === 'Normal' ? value : fallback;
  }

  private asTone(value: unknown): Tone {
    return value === 'good' || value === 'warn' || value === 'bad' ? value : 'warn';
  }

  private normalize(code: string, raw: AiRiskApiResponse | null, fallbackRisk: RiskLabel): AiRiskResult {
    const r: AiRiskApiResponse = raw ?? {};
    const rawShap = Array.isArray(r.shap_factors) ? r.shap_factors
      : Array.isArray(r.shapFactors) ? r.shapFactors : [];

    const shap: ShapFactor[] = rawShap
      .map(f => ({
        feature: String(f?.feature ?? ''),
        label: String(f?.label ?? f?.feature ?? ''),
        impact: Number(f?.impact)
      }))
      .filter(f => Number.isFinite(f.impact) && Math.abs(f.impact) >= MIN_SHAP_IMPACT)
      .sort((a, b) => Math.abs(b.impact) - Math.abs(a.impact))
      .slice(0, MAX_SHAP_FACTORS);

    const actions: CoachingAction[] = (Array.isArray(r.actions) ? r.actions : []).map(a => ({
      icon: String(a?.icon ?? 'info'),
      tone: this.asTone(a?.tone),
      title: String(a?.title ?? ''),
      detail: String(a?.detail ?? '')
    }));

    const goals: AiGoalResult[] = (Array.isArray(r.goals) ? r.goals : []).map(g => {
      const p = Number(g?.p_high);
      return {
        name: String(g?.name ?? ''),
        risk_label: this.asRisk(g?.risk_label, 'Normal'),
        p_high: Number.isFinite(p) ? Math.min(MAX_P_HIGH, Math.max(0, p)) : 0
      };
    });

    return {
      employee_code: r.employee_code ?? code,
      risk_label: this.asRisk(r.risk_label, fallbackRisk),
      shap_factors: shap,
      feedback: String(r.feedback ?? ''),
      actions,
      worst_goal: String(r.worst_goal ?? ''),
      goals
    };
  }
}