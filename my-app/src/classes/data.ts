import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, forkJoin, of } from 'rxjs';
import { map, shareReplay } from 'rxjs/operators';

import { User } from './authService';
import {
  CheckIn,
  DepartmentSummary,
  EmployeeSummary,
  Goal,
  RiskLevel,
  Task,
} from './cpn';

// Angular 17 trở xuống: 'assets/data'. Angular 18 trở lên (thư mục public/): 'data'
const DATA_PATH = 'datasets';
const TASK_COMPLETIONS_KEY = 'cpm_goal_task_completions'; // localStorage: task đã hoàn thành
const CUSTOM_TASKS_KEY = 'cpm_custom_tasks';              // localStorage: đầu việc nhân viên tự thêm
const CUSTOM_TASK_PREFIX = 'custom-'; // id của đầu việc nhân viên tự thêm
const ASSIGNED_GOALS_KEY = 'cpm_assigned_goals';
const FEEDBACK_KEY = 'cpm_manager_feedback';


// "Hôm nay" của dữ liệu mock. Khi có backend thật thì đổi thành new Date()
function todayString(): string {
  const d = new Date();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${month}-${day}`;
}
export const TODAY = todayString();

// Thứ tự để so sánh mức rủi ro (số lớn = nặng hơn)
const RISK_ORDER: Record<RiskLevel, number> = { 'Normal': 0, 'Low Risk': 1, 'High Risk': 2 };

export interface ManagerFeedback {
  text: string;
  by: string;     // tên quản lý
  date: string;
}

@Injectable({ providedIn: 'root' })
export class DataService {
  // Mỗi file JSON chỉ tải một lần, các lần sau dùng lại kết quả cũ
  private cache = new Map<string, Observable<any[]>>();

  constructor(private http: HttpClient) {}

  // ---------------------------------------------------------------------------
  // 1. NGƯỜI DÙNG
  // ---------------------------------------------------------------------------

  getEmployees(): Observable<User[]> {
    return this.load<User>('employees.json').pipe(map((list) => list.map((u) => this.safe(u))));
  }

  getManagers(): Observable<User[]> {
    return this.load<User>('managers.json').pipe(map((list) => list.map((u) => this.safe(u))));
  }

  // Danh sách nhân viên mà người đăng nhập được phép xem
  //   nhân viên: chỉ mình họ | quản lý: nhân viên có managerId của họ | HR: tất cả
  getVisibleEmployees(user: User): Observable<User[]> {
    if (user.role === 'employee') {
      return of([user]);
    }
    if (user.role === 'manager') {
      return this.getEmployees().pipe(map((list) => list.filter((e) => e.managerId === user.id)));
    }
    return this.getEmployees();
  }

  // Quản lý trực tiếp của một nhân viên (undefined nếu không có)
  getManagerOf(employee: User): Observable<User | undefined> {
    return this.getManagers().pipe(map((list) => list.find((m) => m.id === employee.managerId)));
  }

  // ---------------------------------------------------------------------------
  // 2. GOAL, TASK VÀ CHECK-IN
  // ---------------------------------------------------------------------------

  // Toàn bộ goal (kèm danh sách task bên trong) của một nhân viên
  getGoalsOf(employeeId: string): Observable<Goal[]> {
    return this.loadAllGoals().pipe( 
      map((list) => list
        .filter((goal) => goal.employeeId === employeeId)
        .map((goal) => this.applyTaskCompletions(employeeId, goal)))
    );
  }

  // Ghi nhận một task hoàn thành; tỷ lệ KPI được tính từ weight của các task đã xong
  completeTask(employeeId: string, goalId: string, taskId: string): void {
    const completions = this.readTaskCompletions();
    completions[`${employeeId}:${goalId}:${taskId}`] = TODAY;
    localStorage.setItem(TASK_COMPLETIONS_KEY, JSON.stringify(completions));
  }

  // Nhân viên tự thêm một đầu việc con vào goal (trọng số do hệ thống tự chia đều, xem splitWeights)
  addTask(employeeId: string, goalId: string, name: string, dueDate: string): void {
    const all = this.readCustomTasks();
    const key = `${employeeId}:${goalId}`;
    const list = all[key] ?? [];
    list.push({ id: `${CUSTOM_TASK_PREFIX}${Date.now()}`, name, dueDate });
    all[key] = list;
    localStorage.setItem(CUSTOM_TASKS_KEY, JSON.stringify(all));
  }

  // Nhân viên xóa một đầu việc do chính mình thêm (đầu việc có sẵn trong goals.json thì không xóa)
  removeTask(employeeId: string, goalId: string, taskId: string): void {
    const all = this.readCustomTasks();
    const key = `${employeeId}:${goalId}`;
    all[key] = (all[key] ?? []).filter((t) => t.id !== taskId);
    localStorage.setItem(CUSTOM_TASKS_KEY, JSON.stringify(all));

    // Xóa luôn bản ghi "đã hoàn thành" của đầu việc đó (nếu có)
    const completions = this.readTaskCompletions();
    delete completions[`${employeeId}:${goalId}:${taskId}`];
    localStorage.setItem(TASK_COMPLETIONS_KEY, JSON.stringify(completions));
  }
  isCustomTask(taskId: string): boolean {
  return taskId.startsWith(CUSTOM_TASK_PREFIX);
  }

  // Lịch sử check-in của một nhân viên, cũ đến mới
  getCheckinsOf(employeeId: string): Observable<CheckIn[]> {
    return this.load<CheckIn>('checkins.json').pipe(
      map((list) => list.filter((c) => c.employeeId === employeeId))
    );
  }

  // Lịch sử check-in của một goal
  getCheckinsOfGoal(goalId: string): Observable<CheckIn[]> {
    return this.load<CheckIn>('checkins.json').pipe(map((list) => list.filter((c) => c.goalId === goalId)));
  }

    // Biến task manager giao thành một goal thật khi nhân viên nhận.
    // Gọi nhiều lần vẫn an toàn: trùng id thì bỏ qua.
    registerAssignedGoal(
    employeeId: string,
    a: { id: string; name: string; description: string; deadline: string; assignedBy?: string }
    ): void {
    const all = this.readAssignedGoals();
    if (all.some((g) => g.id === a.id)) return;

    all.push({
        id: a.id,
        employeeId,
        name: a.name,
        description: a.description,
        assignedBy: a.assignedBy,
        startDate: TODAY,
        dueDate: a.deadline,
        totalDurationDays: Math.max(1, this.daysBetween(TODAY, a.deadline)),
        status: 'in_progress',
        completedDate: null,
        tasks: []          // nhân viên tự thêm task con
    } as unknown as Goal);

    localStorage.setItem(ASSIGNED_GOALS_KEY, JSON.stringify(all));
    }

    private readAssignedGoals(): Goal[] {
    try {
        return JSON.parse(localStorage.getItem(ASSIGNED_GOALS_KEY) ?? '[]') as Goal[];
    } catch {
        return [];
    }
    }

    // goals.json + goal từ task manager giao
    private loadAllGoals(): Observable<Goal[]> {
    return this.load<Goal>('goals.json').pipe(
        map((list) => [...list, ...this.readAssignedGoals()])
    );
    }

  // ---------------------------------------------------------------------------
  // 3. TÓM TẮT CHO QUẢN LÝ VÀ HR
  // ---------------------------------------------------------------------------

  // Một dòng tóm tắt cho mỗi nhân viên mà người đăng nhập được xem
  getEmployeeSummaries(user: User): Observable<EmployeeSummary[]> {
    return forkJoin([
      this.getVisibleEmployees(user),
      this.loadAllGoals(),
      this.load<CheckIn>('checkins.json'),
    ]).pipe(map(([employees, goals, checkins]) => {
      const currentGoals = goals.map((goal) => this.applyTaskCompletions(goal.employeeId, goal));
      return employees.map((employee) => this.buildSummary(employee, currentGoals, checkins));
    }));
  }

  // Gom các bản tóm tắt nhân viên thành bản tóm tắt theo phòng ban (cho biểu đồ của HR)
  groupByDepartment(summaries: EmployeeSummary[]): DepartmentSummary[] {
    const byDept = new Map<string, DepartmentSummary>();
    for (const s of summaries) {
      const dept = s.employee.department;
      if (!byDept.has(dept)) {
        byDept.set(dept, { department: dept, employeeCount: 0, avgActual: 0, avgExpected: 0, high: 0, low: 0, normal: 0 });
      }
      const d = byDept.get(dept)!;
      d.employeeCount++;
      d.avgActual += s.avgActual;
      d.avgExpected += s.avgExpected;
      if (s.latestRisk === 'High Risk') d.high++;
      else if (s.latestRisk === 'Low Risk') d.low++;
      else d.normal++;
    }
    return Array.from(byDept.values()).map((d) => ({
      ...d,
      avgActual: this.round1(d.avgActual / d.employeeCount),
      avgExpected: this.round1(d.avgExpected / d.employeeCount),
    }));
  }

  // ---------------------------------------------------------------------------
  // 4. HÀM TÍNH TOÁN (dùng trực tiếp trong template: {{ data.currentProgress(goal) }})
  // ---------------------------------------------------------------------------

  // Tiến độ thực tế của goal = tổng trọng số các task đã xong
  currentProgress(goal: Goal): number {
    return goal.tasks
      .filter((t) => t.doneDate !== null)
      .reduce((sum, t) => sum + t.weight, 0);
  }

  // Tiến độ kỳ vọng của goal = % thời gian đã trôi qua
  expectedProgress(goal: Goal): number {
    if (goal.totalDurationDays <= 0) return 0;
    const elapsed = this.daysBetween(goal.startDate, TODAY);
    return this.round1(Math.min(100, Math.max(0, (elapsed / goal.totalDurationDays) * 100)));
  }

// Trung bình tiến độ thực tế / kỳ vọng của các goal truyền vào.
// gap = kỳ vọng - thực tế (chỉ để hiển thị, KHÔNG dùng để xếp rủi ro: xem riskOf)
// score = thực tế / kỳ vọng x 100, chặn tối đa 100
  employeeProgress(goals: Goal[]): { actual: number; expected: number; gap: number; score: number } {
  if (!goals.length) return { actual: 0, expected: 0, gap: 0, score: 0 };
  const avg = (f: (g: Goal) => number) =>
    this.round1(goals.reduce((s, g) => s + f(g), 0) / goals.length);
  const actual = avg((g) => this.currentProgress(g));
  const expected = avg((g) => this.expectedProgress(g));
  return {
    actual,
    expected,
    gap: this.round1(expected - actual),
    score: expected > 0 ? Math.min(100, this.round1((actual / expected) * 100)) : 100,
  };
}

  progressGap(goal: Goal): number {
    return this.round1(this.expectedProgress(goal) - this.currentProgress(goal));
  }

  riskLevelFor(gap: number, overdueTasks: number, daysRemaining: number): RiskLevel {
  // Đỏ: có việc quá hạn, hoặc lệch quá nhiều, hoặc lệch khá nhiều mà sắp hết hạn
  if (overdueTasks >= 1 || gap > 20 || (gap > 10 && daysRemaining < 5)) {
    return 'High Risk';
  }
  // Vàng: lệch vừa, hoặc lệch nhẹ mà thời gian còn ít
  if ((gap >= 5 && gap <= 20) || (gap > 2 && daysRemaining < 10)) {
    return 'Low Risk';
  }
  return 'Normal';
  }

  // Rủi ro = goal đang chạy xấu nhất
  riskOf(goals: Goal[]): RiskLevel {
  let worst: RiskLevel = 'Normal';
  for (const g of goals.filter((x) => x.status === 'in_progress')) {
    const r = this.riskLevelFor(this.progressGap(g), this.overdueTasksOf(g).length, this.daysRemaining(g));
    if (RISK_ORDER[r] > RISK_ORDER[worst]) worst = r;
  }
  return worst;
  }

  // Task đang quá hạn: chưa xong mà hạn đã qua
  isTaskOverdue(task: Task): boolean {
    return task.doneDate === null && task.dueDate < TODAY;
  }

  overdueTasksOf(goal: Goal): Task[] {
    return goal.tasks.filter((t) => this.isTaskOverdue(t));
  }

  // Số ngày còn lại đến hạn của goal (không âm)
  daysRemaining(goal: Goal): number {
    return Math.max(0, this.daysBetween(TODAY, goal.dueDate));
  }

  timeLeftRatio(goal: Goal): number {
    if (goal.totalDurationDays <= 0) return 0;
    return this.round1(this.daysRemaining(goal) / goal.totalDurationDays);
  }

  // ---------------------------------------------------------------------------
  // HÀM NỘI BỘ
  // ---------------------------------------------------------------------------

  private buildSummary(employee: User, goals: Goal[], checkins: CheckIn[]): EmployeeSummary {
    const employeeGoals = goals.filter((goal) => goal.employeeId === employee.id);
    const active = employeeGoals.filter((goal) => goal.status === 'in_progress');
    const mine = checkins.filter((c) => c.employeeId === employee.id);
    const p = this.employeeProgress(employeeGoals);          // chỉ để hiển thị
    const overdue = active.reduce((s, g) => s + this.overdueTasksOf(g).length, 0);
    const latestRisk = this.riskOf(employeeGoals);
    return {
      employee,
      activeGoals: active,
      totalGoals: employeeGoals.length,
      completedGoals: employeeGoals.filter((goal) => goal.status === 'completed').length,
      latestRisk,
      avgActual: p.actual,
      avgExpected: p.expected,
      overdueTotal: overdue,
      lastCheckinDate: mine.length ? mine[mine.length - 1].checkinDate : null,
    };
  }

  /**
   * Ghép dữ liệu gốc (goals.json) với dữ liệu người dùng đã tạo trong trình duyệt (localStorage):
   *  1. Nối đầu việc nhân viên tự thêm vào cuối danh sách task của goal.
   *  2. Chia đều trọng số cho TẤT CẢ đầu việc (bỏ qua weight ghi trong JSON).
   *  3. Đánh dấu đầu việc đã hoàn thành.
   *  4. Goal đã xong hết việc thì status = 'completed'; có thêm việc mới chưa xong thì mở lại thành 'in_progress'.
   */
  private applyTaskCompletions(employeeId: string, goal: Goal): Goal {
    const completions = this.readTaskCompletions();
    const extra = this.readCustomTasks()[`${employeeId}:${goal.id}`] ?? [];

    const merged: Task[] = [
      ...goal.tasks,
      ...extra.map((t) => ({ ...t, weight: 0, doneDate: null, status: 'pending' }) as unknown as Task)
    ];
    const base = this.splitWeights(merged);

    const tasks = base.map((task) => {
      const doneDate = completions[`${employeeId}:${goal.id}:${task.id}`] ?? task.doneDate;
      return doneDate ? { ...task, doneDate, status: 'done' as const } : task;
    });
    const isCompleted = tasks.length > 0 && tasks.every((task) => task.doneDate !== null);

    return {
      ...goal,
      tasks,
      status: isCompleted ? 'completed' : goal.status === 'completed' ? 'in_progress' : goal.status,
      completedDate: isCompleted ? goal.completedDate ?? TODAY : null
    };
  }

  // Chia đều trọng số: mỗi việc = 100 / số việc (làm tròn xuống), việc cuối nhận phần dư để tổng đúng 100.
  // Ví dụ 3 việc: 33 + 33 + 34. Ví dụ 5 việc: 20 x 5.
  private splitWeights(tasks: Task[]): Task[] {
    const n = tasks.length;
  if (!n) return tasks;
  const base = Math.floor(100 / n);
  return tasks.map((t, i) => ({ ...t, weight: i === n - 1 ? 100 - base * (n - 1) : base }));
  }

  private readTaskCompletions(): Record<string, string> {
    try {
      return JSON.parse(localStorage.getItem(TASK_COMPLETIONS_KEY) ?? '{}') as Record<string, string>;
    } catch {
      return {};
    }
  }

  private readCustomTasks(): Record<string, { id: string; name: string; dueDate: string }[]> {
    try {
      return JSON.parse(localStorage.getItem(CUSTOM_TASKS_KEY) ?? '{}');
    } catch {
      return {};
    }
  }

  // Quản lý gửi đánh giá cho nhân viên (mới nhất nằm đầu)
  saveFeedback(employeeId: string, text: string, by: string): void {
    const all = this.readFeedbacks();
    all[employeeId] = [{ text, by, date: TODAY }, ...(all[employeeId] ?? [])];
    localStorage.setItem(FEEDBACK_KEY, JSON.stringify(all));
  }

  getFeedbacksOf(employeeId: string): ManagerFeedback[] {
    return this.readFeedbacks()[employeeId] ?? [];
  }

  private readFeedbacks(): Record<string, ManagerFeedback[]> {
    try {
      return JSON.parse(localStorage.getItem(FEEDBACK_KEY) ?? '{}');
    } catch {
      return {};
    }
  }

  // Đọc một file JSON, nhớ lại để lần sau không tải lại
  private load<T>(file: string): Observable<T[]> {
    if (!this.cache.has(file)) {
      this.cache.set(file, this.http.get<T[]>(`${DATA_PATH}/${file}`).pipe(shareReplay(1)));
    }
    return this.cache.get(file) as Observable<T[]>;
  }

  // Bỏ mật khẩu trước khi đưa ra giao diện
  private safe(user: User): User {
    const copy: User = { ...user };
    delete copy.password;
    return copy;
  }

  private daysBetween(from: string, to: string): number {
    return Math.round((Date.parse(to) - Date.parse(from)) / 86400000);
  }

  private round1(value: number): number {
    return Math.round(value * 10) / 10;
  }
}