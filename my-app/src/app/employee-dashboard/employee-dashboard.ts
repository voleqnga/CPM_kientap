import { ChangeDetectorRef, Component, DestroyRef, HostListener, OnInit, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Router } from '@angular/router';
import { AuthService, User } from '../../classes/authService';
import { DataService, ManagerFeedback } from '../../classes/data';
import { Goal, Task } from '../../classes/cpn';
import { TaskAssignment, TaskAssignmentService } from '../../services/task-assignment.service';



function endOfMonth(): string {
  const last = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0);
  const month = String(last.getMonth() + 1).padStart(2, '0');
  return `${last.getFullYear()}-${month}-${String(last.getDate()).padStart(2, '0')}`;
}

/* ==========================================================================
   PHẦN A. MODELS (kiểu dữ liệu)
   Tạm đặt tại đây, sau này tách ra models/*.ts.
   Tên field snake_case khớp JSON mà API sẽ trả về.
   ========================================================================== */

/** Các chỉ số hợp nhất, hiện ở 6 thẻ chỉ số (mục 3.2 trong HTML) */
export interface UnifiedMetrics {
  actual_progress: number;   // Tiến độ thực tế (%)
  expected_progress: number; // Tiến độ kỳ vọng (%)
  gap: number;               // expected_progress - actual_progress (dương = chậm hơn kế hoạch)
  overdue_tasks: number;     // Số việc quá hạn
  days_remaining: number;    // Số ngày còn lại của kỳ đánh giá
  time_left_ratio: number;   // Tỷ lệ thời gian còn lại / tổng thời lượng
}

export type RiskLabel = 'High Risk' | 'Low Risk' | 'Normal'; // Nhãn rủi ro (mock AI)
export type Tone = 'good' | 'warn' | 'bad';                 
export interface NavItem {
  path: string;
  label: string;
  icon: string;
}

export interface ShapFactor {
  feature: keyof UnifiedMetrics;
  label: string;
  impact: number; // giá trị SHAP: dương = làm tăng rủi ro
}

export interface CoachingAction {
  icon: string;
  tone: Tone;
  title: string;
  detail: string;
}

/** Một khối trong mục 3.5 (mỗi goal một khối) */
export interface ProgressBlock {
  id: string;
  icon: string;
  title: string;
  percent: number;
  expectedPercent: number;
  gap: number;
  tone: Tone;
  leftLabel: string;
  leftValue: string;
  rightLabel: string;
  rightValue: string;
  daysRemaining: number;
  timeLeftRatio: number;
  overdueTasks: number;
  hasSubTasks: boolean;   // goal có task con thật hay không
  completed: boolean;     // goal đã hoàn thành
  tasks: { id: string; name: string; weight: number; done: boolean; dueDate: string }[];
}

/** Một dòng trong bảng chi tiết KPI (mục 3.6) */
export interface KpiRow {
  id: string;
  icon: string;
  name: string;
  description: string;
  target: string;  
  actual: string;
  percent: number;
  tone: Tone;
  statusLabel: string;
  currentValue: number;
  actionType: 'update' | 'view';
  hasSubTasks: boolean;
  done: boolean; // true = goal đã hoàn thành, nằm trong "lịch sử"
}

@Component({
  selector: 'app-employee-dashboard',
  standalone: false,
  templateUrl: './employee-dashboard.html',
  styleUrl: './employee-dashboard.css'
})
export class EmployeeDashboard implements OnInit {

  /* ==========================================================================
     PHẦN B. NẠP DỮ LIỆU (chạy một lần khi mở trang, mọi mục trong HTML đều dựa vào đây)

     Luồng chạy:
       constructor    -> lắng nghe task được quản lý giao (pendingTasks)
       ngOnInit       -> lấy user đăng nhập -> setEmployee -> đọc goals -> applyGoals
       applyGoals     -> tính toàn bộ số liệu rồi gán cho metrics, score, achieved,
                         progressBlocks, kpiRows (HTML chỉ việc hiển thị)
       reloadGoals    -> đọc lại goals sau khi hoàn thành/thêm đầu việc, rồi applyGoals lại
     ========================================================================== */

  private readonly destroyRef = inject(DestroyRef);

  constructor(
    private readonly router: Router,
    private readonly taskAssignmentService: TaskAssignmentService,
    private readonly authService: AuthService,
    private readonly dataService: DataService,
    private readonly changeDetector: ChangeDetectorRef
  ) {
    // Mỗi khi danh sách task được giao thay đổi (quản lý giao mới, nhân viên nhận),
    // cập nhật lại mục 3.3 và bảng KPI.
    this.taskAssignmentService.tasks$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(tasks => {
        this.syncTaskAssignments(tasks);
        this.changeDetector.markForCheck();
      });
  }

  /** Chỉ chạy tiếp nếu người đăng nhập là nhân viên */
  ngOnInit(): void {
    const user = this.authService.currentUser;
    if (!user || user.role !== 'employee') return;

    this.setEmployee(user);
    this.syncTaskAssignments(this.taskAssignmentService.tasks);
    this.taskAssignmentService.tasks
      .filter(t => t.employeeId === user.id && t.status === 'accepted')
      .forEach(t => this.registerAccepted(t));
    this.dataService.getGoalsOf(user.id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: goals => {
          this.applyGoals(goals);
          this.changeDetector.markForCheck();
        },
        error: error => console.error('Failed to load employee goals', error)
      });
    this.feedbacks = this.dataService.getFeedbacksOf(user.id);
  }

  /** Gán thông tin người dùng cho header (2.2) và phần chào hỏi (3.1) */
  private setEmployee(user: User): void {
    this.employee = {
      name: user.fullName,
      code: user.id,
      position: 'Nhân viên',
      department: user.department,
      team: user.department,
      cycleBadge: 'Nhân viên'
    };
    this.lastUpdate = { by: user.fullName, at: 'Đang xem dữ liệu cá nhân' };
  }

  /**
   * Hàm trung tâm: nhận danh sách goal rồi tính toàn bộ số liệu cho giao diện.
   * Tách thành 4 hàm nhỏ, mỗi hàm phục vụ một mục trong HTML.
   */
  private applyGoals(goals: Goal[]): void {
    this.goals = goals;

    this.updateMetrics(goals);       // -> thẻ chỉ số (3.2) + nhãn rủi ro AI (3.4)
    this.buildProgressBlocks(goals); // -> mục 3.5
    this.buildKpiRows(goals);        // -> bảng 3.6

    // Hạn tự đánh giá (3.1) = hạn sớm nhất trong các goal đang chạy
    const activeGoals = goals.filter(goal => goal.status === 'in_progress');
    if (activeGoals.length) {
      this.period.selfEvalDeadline = activeGoals.map(goal => goal.dueDate).sort()[0];
    }
  }

  /**
   * Tính 6 chỉ số của mục 3.2.
   *
   * Công thức:
   *  - Goal "đang chạy" = goal có status 'in_progress'. Nếu không có goal nào đang chạy thì lấy tất cả goal.
   *  - Tiến độ thực tế của 1 goal  = tổng trọng số (weight) các task đã xong (data.currentProgress).
   *  - Tiến độ kỳ vọng của 1 goal  = số ngày đã trôi qua / tổng số ngày x 100, giới hạn 0-100 (data.expectedProgress).
   *  - actual_progress / expected_progress = trung bình cộng của các goal, làm tròn 1 chữ số thập phân.
   *  - gap = expected - actual. Dương = chậm hơn kế hoạch (thẻ đổi sang màu vàng).
   *  - overdue_tasks = tổng số task chưa xong mà hạn đã qua.
   *  - days_remaining = số ngày còn lại NHỎ NHẤT trong các goal đang chạy (goal gấp nhất).
   *  - time_left_ratio = trung bình (số ngày còn lại / tổng số ngày) của các goal đang chạy.
   *  - score.value = tiến độ thực tế trung bình. Xếp loại: từ 90 là Tốt (A), từ 75 là Khá (B), còn lại Cần cải thiện.
   *  - achieved.done = số goal có status 'completed', achieved.total = tổng số goal.
   */
  private updateMetrics(goals: Goal[]): void {
    const activeGoals = goals.filter(goal => goal.status === 'in_progress');
    const metricGoals = activeGoals.length ? activeGoals : goals;
    const p = this.dataService.employeeProgress(metricGoals);

    this.metrics.actual_progress = p.actual;
    this.metrics.expected_progress = p.expected;
    this.metrics.gap = p.gap;
    this.metrics.overdue_tasks = metricGoals.reduce(
      (total, goal) => total + this.dataService.overdueTasksOf(goal).length, 0
    );
    this.metrics.days_remaining = activeGoals.length
      ? Math.min(...activeGoals.map(goal => this.dataService.daysRemaining(goal)))
      : 0;
    this.metrics.time_left_ratio = activeGoals.length
      ? this.average(activeGoals.map(goal => this.dataService.timeLeftRatio(goal)))
      : 0;

    // Nhãn rủi ro của khối AI (mục 3.4): dùng luật trong DataService.riskLevelFor, chưa phải mô hình AI thật
    //   High Risk: gap > 20, hoặc từ 3 việc quá hạn trở lên, hoặc (gap > 10 và còn dưới 5 ngày)
    //   Low Risk : gap từ 5 đến 20, hoặc có 1-2 việc quá hạn, hoặc (gap > 2 và còn dưới 10 ngày)
    //   Normal   : các trường hợp còn lại
    this.ai.risk_label = this.dataService.riskOf(goals);

    this.score.value = p.score;

    this.score.grade = p.score >= 90 ? 'Tốt (A)' : p.score >= 75 ? 'Khá (B)' : 'Cần cải thiện';

    this.achieved.done = goals.filter(goal => goal.status === 'completed').length;
    this.achieved.total = goals.length;
  }

  /** Dựng dữ liệu cho mục 3.5: mỗi goal một khối, kèm danh sách task con */
  private buildProgressBlocks(goals: Goal[]): void {
    this.progressBlocks = goals.map(goal => {
      const percent = this.dataService.currentProgress(goal);
      const gap = this.dataService.progressGap(goal);
      const doneTasks = goal.tasks.filter(task => task.doneDate !== null).length;
      return {
        id: goal.id,
        icon: 'task_alt',
        title: goal.name,
        percent,                                                   // thanh "Thực tế"
        expectedPercent: this.dataService.expectedProgress(goal),  // thanh "Kỳ vọng"
        gap: this.dataService.progressGap(goal),                   // kỳ vọng - thực tế
        tone: this.toneOfGoal(goal),
        leftLabel: 'Task hoàn thành',
        leftValue: `${doneTasks}/${goal.tasks.length}`,
        rightLabel: 'Hạn hoàn thành',
        rightValue: goal.dueDate,
        daysRemaining: this.dataService.daysRemaining(goal),
        timeLeftRatio: this.dataService.timeLeftRatio(goal),
        overdueTasks: this.dataService.overdueTasksOf(goal).length,
        hasSubTasks: this.dataService.hasSubTasks(goal),
        completed: goal.status === 'completed',
        tasks: goal.tasks.map(task => ({
          id: task.id,
          name: task.name,
          weight: task.weight,
          done: task.doneDate !== null,
          dueDate: task.dueDate
        }))
      };
    });
  }

  /**
   * Dựng các dòng của bảng KPI (3.6): mỗi goal một dòng.
   * done = true khi goal đã hoàn thành, dòng đó bị ẩn mặc định và chỉ hiện khi bấm "Xem N mục đã hoàn thành".
   */
  private buildKpiRows(goals: Goal[]): void {
    this.kpiRows = goals.map(goal => {
      const percent = this.dataService.currentProgress(goal);
      const subTasks = this.dataService.realTasksOf(goal);
      const hasSubTasks = subTasks.length > 0;
      const doneSub = subTasks.filter(task => task.doneDate !== null).length;
      const completed = goal.status === 'completed';
      const progressText = hasSubTasks ? `${doneSub}/${subTasks.length} đầu việc hoàn thành` : '';
      return {
        id: goal.id,
        icon: goal.assignedBy ? 'assignment_add' : 'task_alt',
        name: goal.name,
        description: [goal.description, progressText].filter(Boolean).join(' · '),
        target: `Hạn ${goal.dueDate}`,
        actual: hasSubTasks ? `${doneSub}/${subTasks.length} đầu việc` : completed ? 'Đã hoàn thành' : 'Chưa hoàn thành',
        percent,
        tone: this.toneOfGoal(goal),
        statusLabel: completed ? 'Hoàn thành' : 'Đang thực hiện',
        currentValue: percent,
        actionType: 'update' as const,
        hasSubTasks,
        done: completed
      };
    });
  }
  /** Màu của goal theo mức rủi ro: Normal xanh, Low Risk vàng, High Risk đỏ (cùng luật với nhãn ở khối AI) */
  private toneOfGoal(goal: Goal): Tone {
    if (goal.status === 'completed') return 'good';
    const risk = this.dataService.riskLevelFor(
      this.dataService.progressGap(goal),
      this.dataService.overdueTasksOf(goal).length,
      this.dataService.daysRemaining(goal)
    );
    return risk === 'High Risk' ? 'bad' : risk === 'Low Risk' ? 'warn' : 'good';
  }

  /** Trung bình cộng, làm tròn 1 chữ số thập phân. Danh sách rỗng trả về 0. Ví dụ: [100, 60] -> 80 */
  private average(values: number[]): number {
    return values.length
      ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length * 10) / 10
      : 0;
  }

  /**
   * Đọc lại goals từ DataService (đã áp dụng task hoàn thành và task tự thêm) rồi tính lại giao diện.
   * Dùng sau khi hoàn thành hoặc thêm đầu việc. note hiện ở chân bảng KPI.
   */
  private reloadGoals(note: string): void {
    this.dataService.getGoalsOf(this.employee.code)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: goals => {
          this.applyGoals(goals);
          this.lastUpdate = { by: this.employee.name, at: note };
          this.changeDetector.markForCheck();
        },
        error: error => console.error('Failed to reload goals', error)
      });
  }

  /* ==========================================================================
     PHẦN C. THEO THỨ TỰ TRONG HTML
     ========================================================================== */

  /* ---------- 0 + 1. NỀN MỜ VÀ SIDEBAR ---------- */

  sidebarOpen = false; // true = sidebar đang mở (class is-open, nền mờ is-visible)

  /** Nút ☰ ở header */
  toggleSidebar(): void {
    this.sidebarOpen = !this.sidebarOpen;
  }

  /** Nút X, bấm nền mờ, hoặc bấm một mục menu */
  closeSidebar(): void {
    this.sidebarOpen = false;
  }

  /** Dữ liệu menu của sidebar (1.2) */
  navItems: NavItem[] = [
    { path: '/tong-quan',               label: 'Tổng quan',              icon: 'dashboard' },
    { path: '/kpi-cua-toi',             label: 'KPI của tôi',            icon: 'track_changes' },
    { path: '/tien-do-va-bao-cao',      label: 'Tiến độ & Báo cáo',      icon: 'insights' },
    { path: '/tu-danh-gia',             label: 'Tự đánh giá',            icon: 'rate_review' },
    { path: '/nhan-xet-va-coaching-ai', label: 'Nhận xét & Coaching AI', icon: 'psychology' },
    { path: '/cai-dat',                 label: 'Cài đặt',                icon: 'settings' }
  ];

  /** Nhấn Esc: đóng sidebar và mọi modal đang mở */
  @HostListener('document:keydown.escape')
  onEscape(): void {
    this.sidebarOpen = false;
    this.showSelfEvalModal = false;
    this.showAiModal = false;
    this.updatingGoalId = null;
    this.selectedGoalId = null;
  }

  /* ---------- 2. HEADER ---------- */

  /** Logo và ảnh đại diện (dùng ở sidebar, header, phần chào hỏi) */
  assets = {
    logo: 'https://lh3.googleusercontent.com/aida/AEtjO1V1jaUxaQzWm3n-04M5cPoNGnD2ucdXITFrC_P9iK_mQ-ZadikGW4kQ9oAhMAI59rd2myGd0mIAKqZiD8QzeJlSTEFrXRr9lvo3DSjE-UxELisb8Jhlvgpmcz3oiMmph2GPCDT44OPDzh_jA2OkvS2bcDxgztEzzvK2NR0i6-MQpSF8zYRXymkp1IEMUfFmk6xTEhh9lRvzVAtgA9SfgJxu-IpJvo0oP7S4L0tJJ7SkHkGh1bYw9LYe1w',
    avatar: 'https://lh3.googleusercontent.com/aida-public/AB6AXuB8HHSnBhHBSsMSqqLXeCi87hbXGCVLiq82Ns7dWyDz4Cv83l3hQFctz0hezwWt32WPPnYtyGUqllIll8lepvSTeQa8doKX5BwMY1vsh0lXMEfFikzELUFzCoKsHmdK5bmzXbovq7DDAaQArnXmYhTCZe9ohNxB31-_25_ZHzWhJTXzS3tynXGyY0uBF6myLyQ2ahf1J15pM2sJ4V8c9k2ZyAxC_6sCz6fsUHoP5tZeFkZExtHy-kMr'
  };

  /** Hồ sơ nhân viên: gán trong setEmployee() khi mở trang (header + 3.1) */
  employee = {
    name: '',
    code: '',
    position: 'Nhân viên',
    department: '',
    team: '',
    cycleBadge: ''
  };

  /** Kỳ đánh giá (header + 3.1). Nhãn đang cố định, hạn tự đánh giá được cập nhật trong applyGoals() */
  period = {
    label: `Tháng ${new Date().getMonth() + 1}/${new Date().getFullYear()}`,
    selfEvalDeadline: endOfMonth()
  };

  /** Nút "Đăng xuất": xóa phiên đăng nhập rồi về trang login */
  logout(): void {
    this.authService.logout();
    void this.router.navigateByUrl('/app-user-login');
  }

  /* ---------- 3.1 CHÀO HỎI: dùng employee, period, metrics.days_remaining (đã khai báo ở trên) ---------- */

  /* ---------- 3.2 SÁU THẺ CHỈ SỐ ---------- */

  /** Dữ liệu của thẻ 1, 2, 3 (tiến độ thực tế, kỳ vọng, độ lệch) và thẻ 6 (việc quá hạn). Tính trong updateMetrics() */
  metrics: UnifiedMetrics = {
    actual_progress: 0,
    expected_progress: 0,
    gap: 0,
    overdue_tasks: 0,
    days_remaining: 0,
    time_left_ratio: 0
  };

  /** Thẻ 4: điểm số và xếp loại */
  score = { value: 0, max: 100, grade: 'Chưa có dữ liệu' };

  /** Thẻ 5: số goal đã hoàn thành trên tổng số goal */
  achieved = { done: 0, total: 0 };

  /* ---------- 3.3 TASK MỚI ĐƯỢC GIAO (chờ nhận) ---------- */

  pendingTasks: TaskAssignment[] = []; // task quản lý giao, trạng thái 'pending'

  /**
   * Đồng bộ task quản lý giao:
   *  - pendingTasks: task của nhân viên này đang chờ nhận (hiện ở 3.3)
   *  - task đã nhận ('accepted'): thêm thành một dòng trong bảng KPI nếu chưa có
   */
  private syncTaskAssignments(tasks: TaskAssignment[]): void {
  const employeeId = this.employee.code;
  const employeeTasks = tasks.filter(task => task.employeeId === employeeId);
  this.pendingTasks = employeeTasks.filter(task => task.status === 'pending');
  }

  /** Nút "Chấp nhận Task": đổi trạng thái task từ 'pending' sang 'accepted' */
  acceptTask(task: TaskAssignment): void {
    this.taskAssignmentService.acceptTask(task.id, this.employee.code);
    this.registerAccepted(task);
    this.reloadGoals('Vừa nhận một mục tiêu mới');
  }

  private registerAccepted(t: TaskAssignment): void {
  this.dataService.registerAssignedGoal(this.employee.code, {
    id: t.id,
    name: t.name,
    description: t.description,
    deadline: t.deadline,
    assignedBy: t.assignedBy
    });
  }


  /* ---------- 3.4 AI NHẬN XÉT VÀ ĐỀ XUẤT (dữ liệu mock, giữ nguyên) ---------- */

  ai = {
    updatedAt: 'Cập nhật 08:30 hôm nay',
    //engineLabel: 'XGBoost + SHAP · Gemini Coaching',
    risk_label: 'Low Risk' as RiskLabel, // ghi đè trong updateMetrics()
    shapFactors: [
      { feature: 'overdue_tasks',     label: 'Việc quá hạn',      impact: 0.31 },
      { feature: 'actual_progress',   label: 'Tiến độ thực tế',   impact: 0.18 },
      { feature: 'days_remaining',    label: 'Ngày còn lại',      impact: 0.09 },
      { feature: 'expected_progress', label: 'Tiến độ kỳ vọng',   impact: -0.04 }
    ] as ShapFactor[],
    feedback:
      'Kết quả KPI của bạn đang ở mức khá (82/100) và đã đạt 7/10 chỉ tiêu - đây là một tháng làm việc đáng ghi nhận. ' +
      'Hiện tiến độ thực tế (78%) còn chậm 7% so với kỳ vọng (85%), chủ yếu do 2 đầu việc quá hạn ở mảng thu hồi công nợ ' +
      'và khách hàng mới. Với 6 ngày còn lại, nếu ưu tiên xử lý hai việc này trước, bạn hoàn toàn có thể bắt kịp kế hoạch.',
    actions: [
      {
        icon: 'priority_high', tone: 'bad',
        title: '1. Xử lý 2 đầu việc quá hạn trước (đóng góp rủi ro lớn nhất)',
        detail: 'Liên hệ trực tiếp 2 đại lý còn nợ quá hạn và chốt lịch thanh toán trong tuần để kéo tiến độ thu hồi công nợ lên trên 90%.'
      },
      {
        icon: 'timer', tone: 'warn',
        title: '2. Đẩy nhanh khách hàng mới (hiện 12/15)',
        detail: 'Dành 2 buổi chiều để follow-up 3 khách hàng đã gửi báo giá, ưu tiên các dự án có kế hoạch thi công trong tháng.'
      },
      {
        icon: 'star', tone: 'good',
        title: '3. Điểm cộng tuân thủ quy trình CRM',
        detail: 'Bạn cập nhật CRM đầy đủ và đúng hạn 100%. Hãy chia sẻ cách làm này với đồng nghiệp trong buổi họp phòng!'
      }
    ] as CoachingAction[]
  };

  showAiModal = false; // modal 3: chi tiết đề xuất AI

  /** Nút "Xem chi tiết đề xuất" */
  openAiModal(): void {
    this.showAiModal = true;
  }

  closeAiModal(): void {
    this.showAiModal = false;
  }

  /** Nút "Gửi phản hồi cho Trưởng phòng" / "Liên hệ Quản lý": hiện là prompt + alert, chưa gửi đi đâu */
  sendFeedbackToManager(): void {
    const note = prompt('Nhập nhanh ý kiến/kiến nghị gửi tới Trưởng phòng (ví dụ: cần hỗ trợ pháp chế để xử lý công nợ quá hạn):');
    if (note && note.trim().length > 0) {
      alert('Phản hồi của bạn đã được chuyển đến Trưởng phòng Kinh doanh!');
    }
  }

  /* ---------- 3.5 TIẾN ĐỘ THEO TỪNG MỤC TIÊU (chỉ để theo dõi) ---------- */

  progressBlocks: ProgressBlock[] = []; // dựng trong buildProgressBlocks()

  /* ---------- 3.6 BẢNG CHI TIẾT KPI ---------- */

  goals: Goal[] = [];        // dữ liệu gốc từ DataService, các bảng bên dưới đều tính từ đây
  kpiRows: KpiRow[] = [];    // dựng trong buildKpiRows() + syncTaskAssignments()
  lastUpdate = { by: 'Nguyễn Văn An', at: 'Hôm nay 07:15' }; // dòng "Cập nhật gần nhất bởi" ở chân bảng

  showHistory = false;       // true = hiện cả các mục đã hoàn thành

  /** Các dòng bảng đang hiển thị: mặc định ẩn mục đã hoàn thành */
  get visibleKpiRows(): KpiRow[] {
    return this.showHistory ? this.kpiRows : this.kpiRows.filter(r => !r.done);
  }

  /** Số mục đã hoàn thành, hiện trên nút "Xem N mục đã hoàn thành" */
  get historyCount(): number {
    return this.kpiRows.filter(r => r.done).length;
  }

  /** Danh sách task con của một goal, dùng để kiểm tra goal có task không (quyết định hiện nút nào) */
  tasksOf(goalId: string) {
    return this.goals.find(g => g.id === goalId)?.tasks ?? [];
  }

  /** Nút "Xem" (dòng không có task con, ví dụ task được giao): hiện thông tin bằng alert */
  viewKpiDetail(row: KpiRow): void {
    const goal = this.goals.find(g => g.id === row.id);
    const lines = goal?.tasks
      .map(t => `${t.doneDate ? '✔' : '○'} ${t.name} (${t.weight}%) - hạn ${t.dueDate}`)
      .join('\n') ?? '';
    alert(`${row.name}\n${row.description}\n\n${lines}`);
  }

  /* ---------- 4. CÁC MODAL ---------- */

  /* ----- Modal 1: Check-in tiến độ hôm nay (nút ở đầu bảng KPI) ----- */

  updatingGoalId: string | null = null;

  get updatingGoal(): Goal | undefined {
    return this.goals.find(g => g.id === this.updatingGoalId);
  }

  openUpdateModal(goalId: string): void {
    const goal = this.goals.find(g => g.id === goalId);
    if (!goal || !this.dataService.hasSubTasks(goal)) return;
    this.updatingGoalId = goalId;
  }

  /** Nút "Hoàn thành" / "Hoàn thành mục tiêu": goal chưa có task con thì hoàn thành thẳng cả goal */
  completeGoal(goalId: string): void {
    this.dataService.completeGoal(this.employee.code, goalId);
    this.reloadGoals('Vừa hoàn thành một mục tiêu');
  }

  closeUpdateModal(): void {
    this.updatingGoalId = null;
  }

  /* ----- Modal 2: Tự đánh giá tháng ----- */

  showSelfEvalModal = false;

  selfEvalLevels: string[] = [
    'Xuất sắc (Vượt chỉ tiêu & không có sai sót quy trình)',
    'Khá (Đạt đa số chỉ tiêu, còn chậm thu hồi công nợ)',
    'Trung bình (Cần bổ sung kỹ năng đàm phán & chốt hợp đồng)',
    'Chưa đạt (Cần hỗ trợ từ Trưởng phòng Kinh doanh)'
  ];

  // Phải khai báo SAU selfEvalLevels vì dùng selfEvalLevels[1] làm giá trị mặc định
  selfEval = {
    level: this.selfEvalLevels[1],
    difficulties: '',
    proposal: ''
  };

  openSelfEvalModal(): void {
    this.showSelfEvalModal = true;
  }

  closeSelfEvalModal(): void {
    this.showSelfEvalModal = false;
  }

  /** Nút "Xác nhận nộp đánh giá": hiện chỉ alert, chưa lưu đi đâu */
  submitSelfEval(): void {
    alert(`Bản tự đánh giá KPI ${this.period.label} của ${this.employee.name} đã được nộp cho Trưởng phòng Kinh doanh!`);
    this.closeSelfEvalModal();
  }

  /* ----- Modal 3: Chi tiết đề xuất AI: xem openAiModal() / closeAiModal() ở mục 3.4 ----- */

  /* ----- Modal 4: Cập nhật đầu việc của một goal (nút "Cập nhật task" ở bảng KPI) ----- */

  selectedGoalId: string | null = null;      // goal đang chọn trong modal; null = modal đóng
  newTask = { name: '', dueDate: '' };       // form thêm đầu việc (trọng số do hệ thống chia đều)
  addError = '';

  get selectedGoal(): Goal | undefined {
    return this.goals.find(g => g.id === this.selectedGoalId);
  }
  /** Task con thật của goal đang chọn (không gồm task ảo) */
  get selectedGoalTasks(): Task[] {
    const goal = this.selectedGoal;
    return goal ? this.dataService.realTasksOf(goal) : [];
  }
  get manageableGoals(): Goal[] {
  return this.goals.filter(g => g.status !== 'completed');
  }
  /** Nút "Quản lý công việc": mở modal với goal đang chạy đầu tiên (hoặc goal đầu tiên) */
  openManageModal(): void {
    const first = this.manageableGoals[0];
    if (!first) {
      alert('Không còn mục tiêu nào cần thêm việc.');
      return;
    }
    this.selectGoal(first.id);
  }

  /** Đổi goal trong dropdown của modal */
  selectGoal(goalId: string): void {
    this.selectedGoalId = goalId;
    this.addError = '';
    this.newTask = { name: '', dueDate: this.selectedGoal?.dueDate ?? '' };
  }

  closeManageModal(): void {
    this.selectedGoalId = null;
  }

  /** Nút "Hoàn thành" của một đầu việc (modal 1). Modal vẫn mở để tick tiếp. */
  completeGoalTask(goalId: string, taskId: string): void {
    this.dataService.completeTask(this.employee.code, goalId, taskId);
    this.reloadGoals('Vừa hoàn thành một đầu việc');
  }

  /**
   * Nút "Thêm đầu việc": nhân viên chỉ nhập tên và hạn.
   * DataService.addTask lưu đầu việc, rồi tự chia đều trọng số: mỗi việc 100 / số việc (làm tròn xuống),
   * việc cuối nhận phần dư để tổng đúng 100. Ví dụ 3 việc: 33% + 33% + 34%.
   */
  addSubTask(): void {
    const goal = this.selectedGoal;
    const name = this.newTask.name.trim();
    if (!goal || !name) {
      this.addError = 'Nhập tên đầu việc trước khi thêm.';
      return;
    }
    const dueDate = this.newTask.dueDate || goal.dueDate;

    // yyyy-MM-dd so sánh chuỗi được, không cần chuyển sang Date
    if (dueDate > goal.dueDate) {
      this.addError = `Hạn đầu việc không được vượt quá hạn mục tiêu (${goal.dueDate}).`;
      return;
    }

    this.addError = '';
    this.dataService.addTask(this.employee.code, goal.id, name, this.newTask.dueDate || goal.dueDate);
    this.newTask = { name: '', dueDate: goal.dueDate };
    this.reloadGoals('Vừa thêm một đầu việc');
  }
  isCustomTask(taskId: string): boolean {
    return this.dataService.isCustomTask(taskId);
  }

  /** Nút "Xóa": xóa đầu việc tự thêm khỏi goal đang chọn rồi tính lại tiến độ */
  removeSubTask(taskId: string): void {
    const goal = this.selectedGoal;
    if (!goal || !this.isCustomTask(taskId)) return;
    this.dataService.removeTask(this.employee.code, goal.id, taskId);
    this.reloadGoals('Vừa xóa một đầu việc');
  }

  feedbacks: ManagerFeedback[] = [];
}