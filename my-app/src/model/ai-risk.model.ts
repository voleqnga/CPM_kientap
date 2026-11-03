export type RiskLabel = 'High Risk' | 'Low Risk' | 'Normal';
export type Tone = 'good' | 'warn' | 'bad';

/** Một goal gửi lên API */
export interface AiGoalInput {
  name: string;
  expected_progress: number;
  actual_progress: number;
  overdue_tasks: number;
  days_remaining: number;
  total_duration_days: number;
  overdue_items: { name: string; due_date: string; days_late: number }[];
}

export interface AiRiskRequest {
  employee_code: string;
  goals: AiGoalInput[];
  audience: 'employee' | 'manager';
}

/** impact là log-odds, KHÔNG phải phần trăm */
export interface ShapFactor {
  feature: string;
  label: string;
  impact: number;
}

export interface CoachingAction {
  icon: string;
  tone: Tone;
  title: string;
  detail: string;
}

export interface AiGoalResult {
  name: string;
  risk_label: RiskLabel;
  p_high: number; // 0..0.99
}

export interface AiRiskResult {
  employee_code: string;
  risk_label: RiskLabel;      // nhãn tổng = goal tệ nhất
  shap_factors: ShapFactor[];
  feedback: string;
  actions: CoachingAction[];
  worst_goal: string;
  goals: AiGoalResult[];
  unavailable?: boolean;      // true = API lỗi, đang dùng kết quả dự phòng
}