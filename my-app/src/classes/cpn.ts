import { User } from './authService';

// Ba mức rủi ro, khớp với trường riskLevel trong checkins.json
export type RiskLevel = 'Normal' | 'Low Risk' | 'High Risk';

export type TaskStatus = 'done' | 'in_progress' | 'todo';
export type GoalStatus = 'completed' | 'in_progress';

// Một đầu việc nhỏ trong goal (goals.json -> tasks)
export interface Task {
  id: string;
  name: string;
  weight: number;            // task này chiếm bao nhiêu % của goal (tổng = 100)
  dueDate: string;           // YYYY-MM-DD
  doneDate: string | null;   // null = chưa xong
  status: TaskStatus;
}

// Một mục tiêu (goals.json)
export interface Goal {
  id: string;
  employeeId: string;
  name: string;
  startDate: string;
  dueDate: string;
  totalDurationDays: number;
  status: GoalStatus;
  description?: string;
  assignedBy?: string;
  completedDate: string | null;
  tasks: Task[];
}

// Một lần check-in (checkins.json)
export interface CheckIn {
  id: string;
  employeeId: string;
  goalId: string;
  goalName: string;
  checkinDate: string;
  actualProgress: number;
  expectedProgress: number;
  overdueTasks: number;
  daysRemaining: number;
  totalDurationDays: number;
  riskLevel: RiskLevel;
}

// Tóm tắt một nhân viên: dùng cho bảng của quản lý và HR
export interface EmployeeSummary {
  employee: User;
  activeGoals: Goal[];         // các goal đang làm
  totalGoals: number;
  completedGoals: number;
  latestRisk: RiskLevel;       // mức rủi ro cao nhất trong các check-in mới nhất của goal đang làm
  avgActual: number;           // tiến độ thực tế trung bình (%)
  avgExpected: number;         // tiến độ kỳ vọng trung bình (%)
  overdueTotal: number;        // tổng số task đang quá hạn
  lastCheckinDate: string | null;
}

// Tóm tắt một phòng ban: dùng cho biểu đồ của HR
export interface DepartmentSummary {
  department: string;
  employeeCount: number;
  avgActual: number;
  avgExpected: number;
  high: number;                // số nhân viên đang High Risk
  low: number;
  normal: number;
}