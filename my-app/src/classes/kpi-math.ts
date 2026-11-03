import { Goal } from './cpn';
import { DataService } from './data';

/** Làm tròn 1 chữ số thập phân. Không bao giờ trả NaN/Infinity. */
export function round1(n: number): number {
  return Number.isFinite(n) ? Math.round(n * 10) / 10 : 0;
}

/** Goal dùng để tính chỉ số: goal đang chạy; nếu không có thì lấy tất cả. */
export function pickMetricGoals(goals: Goal[]): Goal[] {
  const active = goals.filter(goal => goal.status === 'in_progress');
  return active.length ? active : goals;
}

/** Điểm KPI: đúng công thức của trang employee (DataService.employeeProgress(...).score). Truyền TOÀN BỘ goal. */
export function kpiScoreOf(data: DataService, goals: Goal[]): number {
  return data.employeeProgress(pickMetricGoals(goals)).score;
}