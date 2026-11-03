import { ChangeDetectorRef, Component, DestroyRef, HostListener, OnDestroy, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Router } from '@angular/router';
import { AuthService, User } from '../../classes/authService';
import { DataService, TODAY } from '../../classes/data';
import { EmployeeSummary, Goal } from '../../classes/cpn';
import { AiRiskResult, RiskLabel } from '../../model/ai-risk.model';
import { AiRiskService, pHighPercent } from '../../services/ai-risk';
import { kpiScoreOf, pickMetricGoals, round1 } from '../../classes/kpi-math';
import { TaskAssignmentService } from '../../services/task-assignment.service';
import { Subscription, forkJoin, from, of } from 'rxjs';
import { map, mergeMap, switchMap } from 'rxjs/operators';



/* ==========================================================
   MODELS (tạm đặt tại đây — sau này gom vào models/*.ts dùng chung
   với dashboard.component.ts)
   Tên field snake_case khớp JSON mà API sẽ trả về.
   ========================================================== */
const AI_CONCURRENCY = 4;

export interface UnifiedMetrics {
  actual_progress: number;   // Tiến độ thực tế (%)
  expected_progress: number; // Tiến độ kỳ vọng (%)
  overdue_tasks: number;     // Số việc quá hạn
  days_remaining: number;    // Số ngày còn lại
}

export interface NavItem {
  path: string;
  label: string;
  icon: string;
}

export interface Employee {
  code: string;
  name: string;
  initials: string;
  jobTitle: string;
  team: string;
  teamName: string;
  kpi: number;                 // KPI hiện tại (%)
  kpiTarget: number;           // Mục tiêu (%)
  selfAssessment: string;      // Tự đánh giá
  statusLabel: string;         // Nhãn hiển thị
  risk_label: RiskLabel;       // Nhãn của AI nếu đã có, chưa có thì nhãn theo luật
  rule_risk: RiskLabel;        // Nhãn theo luật (DataService.riskOf): chỉ dùng khi AI chưa trả kết quả hoặc API lỗi.
  feedback: string;            // nhận xét của quản lý ('' = chưa đánh giá)
  metrics: UnifiedMetrics;
  overdueItems: OverdueItem[];
  forecast: number;
  goals: Goal[];               // toàn bộ goal của nhân viên (đầu vào gọi API AI)
}

export interface ShapBar {
  feature: string;
  label: string;
  impact: number;     // log-odds, chỉ để trong tooltip
  width: number;      // % chiều dài thanh, 0-100
  positive: boolean;  // true = làm tăng rủi ro (đỏ)
  share: number;
}

export interface OverdueItem {
  goal: string;
  dueDate: string;
  daysLate: number;
}

export interface DetailEmployee {
  code: string;
  name: string;
  initials: string;
  jobTitle: string;
  status: string;
  username: string;
  departmentLabel: string;
  risk_label: RiskLabel;
}

export interface DetailStats {
  actual: number;
  expected: number;
  gap: number;
  overdue: number;
  completedGoals: number;
  totalGoals: number;
  activeGoals: number;
}


@Component({
  selector: 'app-manager-dashboard',
  standalone: false,
  templateUrl: './manager-dashboard.html',
  styleUrl: './manager-dashboard.css',
})
export class ManagerDashboard implements OnDestroy {
  navItems: NavItem[] = [
    { path: '/tong-quan',                    label: 'Tổng quan',              icon: 'dashboard' },
    { path: '/kpi-cua-toi',                  label: 'KPI của tôi',            icon: 'track_changes' },
    { path: '/tien-do-va-bao-cao',           label: 'Tiến độ & Báo cáo',      icon: 'insights' },
    { path: '/tu-danh-gia',                  label: 'Tự đánh giá',            icon: 'rate_review' },
    { path: '/nhan-xet-va-coaching-ai',      label: 'Nhận xét & Coaching AI', icon: 'psychology' },
    { path: '/quan-ly-nhan-su-va-phan-quyen', label: 'Quản lý',               icon: 'group' },
    { path: '/cai-dat',                      label: 'Cài đặt',                icon: 'settings' }
  ];
  roles: string[] = ['Nhân viên', 'Quản lý', 'HR Nhân sự'];
  selectedRole = 'Quản lý';
  assignableEmployees: User[] = [];
  private readonly destroyRef = inject(DestroyRef);
  private alertSub?: Subscription;
  private aiBgSub?: Subscription;
  today = TODAY;

  constructor(
    private readonly router: Router,
    private readonly taskAssignmentService: TaskAssignmentService,
    private readonly authService: AuthService,
    private readonly dataService: DataService,
    private readonly aiRiskService: AiRiskService,
    private readonly changeDetector: ChangeDetectorRef
  ) {
    const currentUser = this.authService.currentUser;
    if (currentUser?.role === 'manager') {
      this.manager = { name: currentUser.fullName, position: 'Trưởng phòng' };
      this.dataService.getEmployeeSummaries(currentUser)
        .pipe(
          switchMap(summaries =>
            (summaries.length
              ? forkJoin(summaries.map(s => this.dataService.getGoalsOf(s.employee.id)))
              : of([] as Goal[][])
            ).pipe(map(goalLists => ({ summaries, goalLists })))
          ),
          takeUntilDestroyed(this.destroyRef)
        )
        .subscribe(({ summaries, goalLists }) => {
          this.employeeSummaries = summaries;
          this.assignableEmployees = summaries.map(summary => summary.employee);
          this.employees = summaries.map((summary, i) => this.toEmployee(summary, goalLists[i] ?? []));
          this.updateSummary();
          this.teamOptions = [
            { value: 'all', label: 'Tất cả phòng ban' },
            ...Array.from(new Set(this.employees.map(employee => employee.team)))
              .map(department => ({ value: department, label: department }))
          ];
          this.taskDraft.employeeId = this.assignableEmployees[0]?.id ?? '';
          this.pages = [1];
          // ĐÃ SỬA: gọi selectAlert để SHAP/Coaching cũng được sinh theo nhân viên đầu tiên
          const first = this.riskQueue[0] ?? this.employees[0] ?? null;
          if (first) {
            this.selectAlert(first);
          } else {
            this.aiAlert.employee = null;
          }
          this.loadAiInBackground();
          this.changeDetector.markForCheck();
        });
    } else {
      // ĐÃ THÊM: người dùng không phải manager thì đưa về trang đăng nhập
      void this.router.navigateByUrl('/app-user-login');
    }
  }

  private toEmployee(summary: EmployeeSummary, goals: Goal[]): Employee {
    const employee = summary.employee;
    const ruleRisk = summary.latestRisk;
    const hasGoals = goals.length > 0;
    const metricGoals = pickMetricGoals(goals);
    const p = this.dataService.employeeProgress(metricGoals);
    const score = kpiScoreOf(this.dataService, goals);


    const overdueItems: OverdueItem[] = metricGoals.flatMap(goal => {
    const late = this.dataService.overdueTasksOf(goal);
    if (!late.length) return [];
    const earliest = late.map(t => t.dueDate).sort()[0];
    return [{
      goal: goal.name,
      dueDate: earliest,
      daysLate: Math.round((Date.parse(TODAY) - Date.parse(earliest)) / 86400000)
      }];
    });
    const activeGoals = goals.filter(goal => goal.status === 'in_progress');
    return {
      code: employee.id,
      name: employee.fullName,
      initials: employee.fullName.split(/\s+/).slice(-2).map(part => part[0]).join('').toUpperCase(),
      jobTitle: 'Nhân viên',
      team: employee.department,
      teamName: employee.department,
      kpi: score,
      kpiTarget: 85,
      selfAssessment: `${summary.activeGoals.length} mục tiêu đang chạy · ${summary.completedGoals}/${summary.totalGoals} mục tiêu hoàn thành`,
      statusLabel: this.statusLabelOf(hasGoals, ruleRisk, score),
      risk_label: ruleRisk,
      rule_risk: ruleRisk,
      feedback: this.dataService.getFeedbacksOf(employee.id)[0]?.text ?? '',
      overdueItems,
      forecast: score, // dự báo hoàn thành = thực tế / kỳ vọng, chính là điểm KPI
      goals,
      metrics: {
        actual_progress: p.actual,
        expected_progress: p.expected,
        overdue_tasks: overdueItems.length,
        days_remaining: activeGoals.length
          ? Math.min(...activeGoals.map(goal => this.dataService.daysRemaining(goal)))
          : 0
      }
    };
  }

  private statusLabelOf(hasGoals: boolean, risk: RiskLabel, score: number): string {
    return !hasGoals ? 'Chưa có mục tiêu'
      : risk === 'High Risk' ? 'Rủi ro'
      : risk === 'Low Risk' ? 'Cảnh báo'
      : score >= 90 ? 'Tốt' : 'Đạt';
  }


  private updateSummary(): void {
    const count = this.employees.length;
    const achievedCount = this.employees.filter(employee => employee.kpi >= employee.kpiTarget).length;
    const atRiskCount = this.employees.filter(employee => employee.risk_label !== 'Normal').length;
    this.summary = {
      totalStaff: count,
      teamCount: new Set(this.employees.map(employee => employee.team)).size,
      attendance: `${count} nhân viên theo dữ liệu`,
      avgKpi: count ? round1(this.employees.reduce((sum, employee) => sum + employee.kpi, 0) / count) : 0,
      avgKpiDelta: 'Tính từ goal đang chạy',
      kpiTarget: 85,
      achievedCount,
      achievedPercent: count ? `${Math.round(achievedCount / count * 100)}%` : '0%',
      atRiskCount,
      atRiskPercent: count ? `${Math.round(atRiskCount / count * 100)}%` : '0%'
    };
  }

  logout(): void {
    this.authService.logout();
    void this.router.navigateByUrl('/app-user-login');
  }

  sidebarOpen = false;

  toggleSidebar(): void {
    this.sidebarOpen = !this.sidebarOpen;
  }

  closeSidebar(): void {
    this.sidebarOpen = false;
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    this.closeSidebar();
    this.showAssignTaskModal = false;
    this.review.open = false;
    this.closeDetailModal();
  }

  assets = {
    logo: 'https://saca.com.vn/vnt_upload/partner/son_dong_nai.jpg',
    avatar: 'https://lh3.googleusercontent.com/aida-public/AB6AXuB8HHSnBhHBSsMSqqLXeCi87hbXGCVLiq82Ns7dWyDz4Cv83l3hQFctz0hezwWt32WPPnYtyGUqllIll8lepvSTeQa8doKX5BwMY1vsh0lXMEfFikzELUFzCoKsHmdK5bmzXbovq7DDAaQArnXmYhTCZe9ohNxB31-_25_ZHzWhJTXzS3tynXGyY0uBF6myLyQ2ahf1J15pM2sJ4V8c9k2ZyAxC_6sCz6fsUHoP5tZeFkZExtHy-kMr'
  };

  /* ---------- MOCK: người dùng & bối cảnh ---------- */
  manager = { name: '', position: 'Trưởng phòng' };

  pageInfo = {
    location: 'Văn phòng Trụ sở Long Thành',
    title: 'Quản lý Phòng Kinh doanh DONASA - Báo cáo & Đánh giá Nhóm Dự án & Đại lý',
    subtitle: 'Báo cáo tổng hợp tiến độ, KPI, rủi ro và nhận xét nhân viên'
  };

  /* ---------- Bộ lọc (Template-Driven + [(ngModel)]) ---------- */
  teamOptions = [
    { value: 'all', label: 'Tất cả phòng ban' }
  ];
  periodOptions = [
    { value: '2026-10', label: 'Tháng 10/2026' },
    { value: '2026-09', label: 'Tháng 09/2026' },
    { value: '2026-08', label: 'Tháng 08/2026' }
  ];
  filters = {
    team: 'all',
    period: '2026-10',
    search: ''
  };

  showAssignTaskModal = false;
  assignError = '';
  taskDraft = {
    employeeId: '',
    name: '',
    description: '',
    deadline: TODAY,
  };

  /* ---------- MOCK: 4 thẻ tổng hợp ---------- */
  summary = {
    totalStaff: 0,
    teamCount: 0,
    attendance: 'Đang tải dữ liệu',
    avgKpi: 0,
    avgKpiDelta: 'Từ goal đang chạy',
    kpiTarget: 85,
    achievedCount: 0,
    achievedPercent: '0%',
    atRiskCount: 0,
    atRiskPercent: '0%'
  };

  /* ---------- kết quả AI (XGBoost + SHAP ) (lấy từ AiRiskService) ---------- */
  aiAlert = {
    engineLabel: 'Hệ thống phân tích dữ liệu tự động từ CRM và phần mềm công nợ kế toán',
    employee: null as Employee | null,
    loading: false,
    unavailable: false,
    result: null as AiRiskResult | null,
    pHigh: null as number | null,     // p_high của worst_goal, tối đa 99; null = chưa có
    worstGoal: '',
    shapBars: [] as ShapBar[]
  };

  /* ---------- Dữ liệu bảng ---------- */
  employees: Employee[] = [];

  /* ---------- Modal chi tiết nhân viên (giống HR) ---------- */
  selectedEmployeeForDetail: DetailEmployee | null = null;
  detailStats: DetailStats | null = null;  employeeSummaries: EmployeeSummary[] = [];
  goalDeadlines: { name: string; days: number }[] = [];
  goalsLoading = false;
  isDetailModalOpen = false;
  private goalsSub?: Subscription;

  /** Lọc đơn giản theo nhóm + từ khóa. Khi có API sẽ chuyển sang Service. */
  sortBy: 'default' | 'risk' | 'kpiAsc' | 'kpiDesc' | 'name' = 'default';

  private readonly riskRank: Record<RiskLabel, number> = {
    'High Risk': 0, 'Low Risk': 1, 'Normal': 2
  };

  get filteredEmployees(): Employee[] {
    const keyword = this.filters.search.trim().toLowerCase();
    const list = this.employees.filter(e =>
      (this.filters.team === 'all' || e.team === this.filters.team) &&
      (!keyword || e.name.toLowerCase().includes(keyword) || e.code.toLowerCase().includes(keyword))
    );

    switch (this.sortBy) {
      case 'risk':    return list.sort((a, b) => this.riskRank[a.risk_label] - this.riskRank[b.risk_label] || a.kpi - b.kpi);
      case 'kpiAsc':  return list.sort((a, b) => a.kpi - b.kpi);
      case 'kpiDesc': return list.sort((a, b) => b.kpi - a.kpi);
      case 'name':    return list.sort((a, b) => a.name.localeCompare(b.name, 'vi'));
      default:        return list;
    }
  }

  sortOpen = false;
  sortOptions: { value: 'default' | 'risk' | 'kpiAsc' | 'kpiDesc' | 'name'; label: string }[] = [
    { value: 'default', label: 'Mặc định' },
    { value: 'risk',    label: 'Rủi ro cao trước' },
    { value: 'kpiAsc',  label: 'KPI thấp → cao' },
    { value: 'kpiDesc', label: 'KPI cao → thấp' },
    { value: 'name',    label: 'Tên A → Z' }
  ];

  setSort(value: 'default' | 'risk' | 'kpiAsc' | 'kpiDesc' | 'name'): void {
    this.sortBy = value;
    this.sortOpen = false;
  }

  /* ---------- Phân trang (mock) ---------- */
  pages: number[] = [1, 2, 3];
  currentPage = 1;

  goToPage(page: number): void {
    this.currentPage = page;
  }

  prevPage(): void {
    if (this.currentPage > 1) this.currentPage--;
  }

  nextPage(): void {
    if (this.currentPage < this.pages.length) this.currentPage++;
  }

  /* ==========================================================
     EVENT HANDLERS — chỉ cập nhật state UI
     TODO: thay alert bằng gọi Service (HttpClient) khi có API, ví dụ
           this.kpiService.approve(emp.code, emp.proposedScore).subscribe(...)
     ========================================================== */

  exportPdf(): void {
    alert('Đang xuất báo cáo PDF tháng ' + this.filters.period + '...');
  }

  /* ---------- ĐÁNH GIÁ & COACHING ---------- */
  selected = new Set<string>();   // mã NV được tick để gửi hàng loạt
  review = { open: false, targets: [] as Employee[], ai: '', text: '' };

  get selectedList(): Employee[] {
    return this.filteredEmployees.filter(e => this.selected.has(e.code));
  }

  get allSelected(): boolean {
    return this.filteredEmployees.length > 0 && this.filteredEmployees.every(e => this.selected.has(e.code));
  }

  toggle(code: string): void {
    this.selected.has(code) ? this.selected.delete(code) : this.selected.add(code);
  }

  toggleAll(): void {
    const all = this.allSelected;
    this.filteredEmployees.forEach(e => all ? this.selected.delete(e.code) : this.selected.add(e.code));
  }

  openReview(targets: Employee[]): void {
    this.review = { open: true, targets, ai: '', text: targets.length === 1 ? targets[0].feedback : '' };
  }

    /**
   * Soạn nháp nhận xét cục bộ từ số liệu tiến độ và việc quá hạn (không gọi API).
   *  - 1 người nhận: lời nhận xét riêng, có tên.
   *  - Nhiều người nhận: bản chung dùng {tên}, khi gửi sẽ thay bằng tên từng người.
   */
  
generateAi(): void {
  const t = this.review.targets;
  if (!t.length) return;
  this.review.ai = t.length === 1 ? this.coachSingle(t[0]) : this.coachGroup(t);
}

/** Lời nhận xét cho 1 nhân viên */
private coachSingle(e: Employee): string {
  const name = this.firstName(e);
  const actual = Math.round(e.metrics.actual_progress);
  const expected = Math.round(e.metrics.expected_progress);
  const gap = expected - actual;

  const late = [...e.overdueItems].sort((a, b) => b.daysLate - a.daysLate);
  const worst = late[0];
  const lateGoals = late.slice(0, 2).map(i => `“${i.goal}”`).join(' và ');

  // Chậm nhiều: trao đổi về tình hình và hướng xử lý
  if (gap >= 30 || (late.length > 0 && gap >= 15)) {
    return `Chào ${name}, tiến độ hiện tại của em là ${actual}%, thấp hơn mức dự kiến ${expected}%. ` +
      (worst
        ? `Mục tiêu “${worst.goal}” có việc đã quá hạn ${worst.daysLate} ngày. `
        : '') +
      `Em cập nhật giúp anh tình hình các đầu việc hiện tại nhé, nhất là những phần đang ảnh hưởng đến tiến độ. ` +
      `Mình sẽ cùng xem lại để thống nhất hướng xử lý phù hợp.`;
  }

  // Chậm vừa: nhắc ưu tiên và cập nhật tiến độ
  if (gap >= 5 || late.length > 0) {
    return `Chào ${name}, tiến độ hiện tại là ${actual}%, chưa đạt mức dự kiến ${expected}%. ` +
      (late.length
        ? `Em ưu tiên xử lý các việc quá hạn thuộc ${lateGoals} trước nhé. `
        : `Em theo sát các đầu việc còn lại để kịp tiến độ kế hoạch nhé. `) +
      `Nếu có thay đổi nào ảnh hưởng đến tiến độ, em cập nhật sớm để mình nắm tình hình.`;
  }

  // Đạt hoặc vượt: ghi nhận kết quả
  return `Chào ${name}, tiến độ hiện tại của em là ${actual}%, đạt/vượt mức dự kiến ${expected}%. ` +
    `Em tiếp tục duy trì tiến độ này nhé.`;
  }

  /** Ký hiệu tên trong bản nháp nhiều người; khi gửi sẽ được thay bằng tên từng người. */
  private readonly NAME_TOKEN = '{tên}';

  /** Lời nhận xét soạn một lần cho nhiều người */
  private coachGroup(t: Employee[]): string {
    const behind = t.filter(e =>
      e.metrics.expected_progress - e.metrics.actual_progress >= 5 || e.overdueItems.length > 0
    ).length;
    const ratio = behind / t.length;
    const hi = this.NAME_TOKEN;

    // Từ 2/3 số người được chọn đang chậm hoặc có mục tiêu quá hạn
    if (ratio >= 2 / 3) {
      return `Chào ${hi}, em rà soát lại tiến độ các mục tiêu trong kỳ và ưu tiên những đầu việc đang chậm hoặc quá hạn nhé. ` +
        `Nếu có vấn đề ảnh hưởng đến kế hoạch, em cập nhật để mình cùng xem xét hướng xử lý.`;
    }

    // Từ 1/3 trở xuống đang chậm hoặc có mục tiêu quá hạn
    if (ratio <= 1 / 3) {
      return `Chào ${hi}, em tiếp tục duy trì tiến độ công việc trong kỳ nhé. ` +
        `Đồng thời, em theo dõi các mục tiêu còn lại và cập nhật kết quả khi có thay đổi.`;
    }

    // Tình hình chung chưa đồng đều
    return `Chào ${hi}, em tiếp tục theo dõi tiến độ các mục tiêu trong kỳ nhé. ` +
      `Nếu có đầu việc chưa theo kịp kế hoạch, em chủ động rà soát và cập nhật tình hình để mình nắm được.`;
  }

  /** Tên gọi = từ cuối của họ tên */
  private firstName(e: Employee): string {
    return e.name.trim().split(/\s+/).pop() ?? e.name;
  }

  /** Thay ký hiệu tên bằng tên của từng người nhận */
  private personalize(text: string, e: Employee): string {
    return text.split(this.NAME_TOKEN).join(this.firstName(e));
  }


  applyAi(): void {
    this.review.text = this.review.ai;
  }

  sendReview(): void {
  const text = this.review.text.trim();
  if (!text) return;
  this.review.targets.forEach(e => {
    const personal = this.personalize(text, e);   // mỗi người nhận một bản đã điền tên riêng
    e.feedback = personal;
    this.dataService.saveFeedback(e.code, personal, this.manager.name);
  });
  alert(`Đã gửi đánh giá cho ${this.review.targets.length} nhân viên.`);
  this.selected.clear();
  this.review.open = false;
}

  removeTarget(e: Employee): void {
    this.review.targets = this.review.targets.filter(t => t.code !== e.code);
    this.selected.delete(e.code);
    if (this.review.targets.length === 0) this.review.open = false;
  }

  onAlertAction(action: 'support' | 'adjust' | 'detail'): void {
    if (action === 'support' && this.aiAlert.employee) {
      this.openReview([this.aiAlert.employee]);
      return;
    }
    const labels = {
      support: 'Gửi yêu cầu hỗ trợ',
      adjust: 'Mở màn hình điều chỉnh KPI',
      detail: 'Xem chi tiết cảnh báo'
    };
    alert(`${labels[action]} - ${this.aiAlert.employee?.name ?? 'nhân viên'}`);
  }

  onToolClick(tool: 'assign' | 'weight' | 'meeting'): void {
    if (tool === 'assign') {
      this.showAssignTaskModal = true;
      return;
    }

    const labels = {
      assign: 'Giao chỉ tiêu KPI mới',
      weight: 'Điều chỉnh trọng số KPI',
      meeting: 'Đặt lịch họp Coaching định kỳ'
    };
    alert(`${labels[tool]} (chức năng sẽ nối API sau).`);
  }

  closeAssignTaskModal(): void {
    this.showAssignTaskModal = false;
  }

  assignTask(): void {
    const employee = this.assignableEmployees.find(item => item.id === this.taskDraft.employeeId);
    const name = this.taskDraft.name.trim();
    const description = this.taskDraft.description.trim();

    if (!employee) {
      this.assignError = 'Chưa chọn nhân viên nhận task.';
      return;
    }
    if (!name || !description || !this.taskDraft.deadline) {
      this.assignError = 'Vui lòng nhập đủ tên task, mô tả và hạn hoàn thành.';
      return;
    }
    // So sánh chuỗi chỉ đúng khi TODAY có dạng YYYY-MM-DD
    if (this.taskDraft.deadline < this.today) {
      this.assignError = 'Hạn hoàn thành không được ở trong quá khứ.';
      return;
    }
    this.assignError = '';

    this.taskAssignmentService.assignTask({
      employeeId: employee.id,
      employeeName: employee.fullName,
      name,
      description,
      deadline: this.taskDraft.deadline,
      assignedBy: this.manager.name
    });

    this.showAssignTaskModal = false;
    this.taskDraft = {
      employeeId: this.assignableEmployees[0]?.id ?? '',
      name: '',
      description: '',
      deadline: TODAY
    };
    alert(`Đã giao task "${name}" cho ${employee.fullName}.`);
  }

  // Bảng AI
  // Hàng đợi: đỏ trước, rồi nhiều việc quá hạn, rồi KPI thấp
  get riskQueue(): Employee[] {
    return this.employees
      .filter(e => e.risk_label !== 'Normal')
      .sort((a, b) =>
        this.riskRank[a.risk_label] - this.riskRank[b.risk_label] ||
        b.metrics.overdue_tasks - a.metrics.overdue_tasks ||
        a.kpi - b.kpi);
  }

  /**
   * Chọn nhân viên trong hàng đợi: gọi API AI (service cache, chọn lại người đã xem thì không gọi lại).
   * KHÔNG gọi API trong getter hoặc template.
   */
  selectAlert(e: Employee): void {
    this.aiAlert.employee = e;
    this.aiAlert.loading = true;
    this.aiAlert.unavailable = false;
    this.aiAlert.result = null;
    this.aiAlert.pHigh = null;
    this.aiAlert.worstGoal = '';
    this.aiAlert.shapBars = [];

    this.alertSub?.unsubscribe(); // bỏ request cũ để kết quả muộn không ghi đè người đang chọn
    this.alertSub = this.aiRiskService.analyze(e.code, e.goals, 'manager')
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(result => {
        this.showAlertResult(result);
        this.applyAiResult(e, result);
        this.changeDetector.markForCheck();
      });
  }

  /** Đổ kết quả API vào khối "AI cảnh báo": SHAP (thanh), feedback, actions, p_high của goal tệ nhất */
  private showAlertResult(result: AiRiskResult): void {
    this.aiAlert.loading = false;
    this.aiAlert.unavailable = !!result.unavailable;
    this.aiAlert.result = result;

    this.aiAlert.shapBars = this.toShapBars(result);

    const worst = result.goals.find(g => g.name === result.worst_goal)
      ?? [...result.goals].sort((a, b) => b.p_high - a.p_high)[0];
    this.aiAlert.pHigh = worst ? pHighPercent(worst.p_high) : null;
    this.aiAlert.worstGoal = worst?.name ?? result.worst_goal;
  }

    /** Dựng các thanh nguyên nhân: độ dài thanh = tỷ trọng (%) của yếu tố đó trong tổng các yếu tố đang hiện */
  private toShapBars(result: AiRiskResult): ShapBar[] {
    const total = result.shap_factors.reduce((sum, f) => sum + Math.abs(f.impact), 0);
    return result.shap_factors.map(f => {
      const share = total > 0 ? Math.round(Math.abs(f.impact) / total * 100) : 0;
      return { feature: f.feature, label: f.label, impact: f.impact, width: share, share, positive: f.impact > 0 };
    });
  }

  /** Cập nhật nhãn rủi ro của nhân viên theo kết quả AI (API lỗi thì giữ nhãn theo luật) */
  private applyAiResult(e: Employee, result: AiRiskResult): void {
    e.risk_label = result.unavailable ? e.rule_risk : result.risk_label;
    e.statusLabel = this.statusLabelOf(e.goals.length > 0, e.risk_label, e.kpi);
    this.updateSummary();
    this.changeDetector.markForCheck();
  }

  /** Tải nền kết quả AI cho cả danh sách, tối đa AI_CONCURRENCY request song song */
  private loadAiInBackground(): void {
    this.aiBgSub?.unsubscribe();
    this.aiBgSub = from(this.employees).pipe(
      mergeMap(
        e => this.aiRiskService.analyze(e.code, e.goals, 'manager').pipe(map(result => ({ e, result }))),
        AI_CONCURRENCY
      ),
      takeUntilDestroyed(this.destroyRef)
    ).subscribe(({ e, result }) => this.applyAiResult(e, result));
  }
  // Mở popup đánh giá với nội dung AI đã soạn sẵn trong ô của quản lý
  coachWithAi(e: Employee): void {
    this.openReview([e]);
    this.generateAi();
    this.applyAi();
  }

  // Mở popup giao task với nhân viên đã chọn sẵn
  reassign(e: Employee): void {
    this.taskDraft.employeeId = e.code;
    this.showAssignTaskModal = true;
  }

  // Lọc bảng về đúng người này
  focusInTable(e: Employee): void {
    this.filters.search = e.code;
  }

  /* ==========================================================
     MODAL CHI TIẾT NHÂN VIÊN (View Profile) — giống bên HR
     ========================================================== */

  viewProfile(emp: Employee, withAi = false): void {
    const summary = this.employeeSummaries.find(s => s.employee.id === emp.code) ?? null;

    // Map Employee (manager) -> DetailEmployee để khớp với template dùng chung với HR
    this.selectedEmployeeForDetail = {
      code: emp.code,
      name: emp.name,
      initials: emp.initials,
      jobTitle: emp.jobTitle,
      status: emp.statusLabel,
      username: summary?.employee.username ?? '',
      departmentLabel: emp.teamName,
      risk_label: emp.risk_label
    };
    const m = emp.metrics;
    this.detailStats = {
      actual: round1(m.actual_progress),
      expected: round1(m.expected_progress),
      gap: round1(m.expected_progress - m.actual_progress),
      overdue: m.overdue_tasks,
      completedGoals: summary?.completedGoals ?? 0,
      totalGoals: summary?.totalGoals ?? emp.goals.length,
      activeGoals: emp.goals.filter(g => g.status === 'in_progress').length
    };
    this.goalDeadlines = [];
    this.goalsLoading = true;
    this.isDetailModalOpen = true;

    this.goalsSub?.unsubscribe();
    this.goalsSub = this.dataService.getGoalsOf(emp.code)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: goals => {
          this.goalDeadlines = goals.map(goal => ({
            name: goal.name,
            days: this.dataService.daysRemaining(goal)
          }));
          this.goalsLoading = false;
          this.changeDetector.markForCheck();
        },
        error: () => {
          this.goalsLoading = false;
          this.changeDetector.markForCheck();
        }
      });
    this.detailWithAi = withAi;
    this.detailAiSub?.unsubscribe();
    if (withAi) {
      this.detailAi = { loading: true, unavailable: false, result: null, shapBars: [] };
      this.detailAiSub = this.aiRiskService.analyze(emp.code, emp.goals, 'manager')
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe(result => {
          this.detailAi = { loading: false, unavailable: !!result.unavailable, result, shapBars: this.toShapBars(result) };
          this.changeDetector.markForCheck();
        });
    }
  }

  closeDetailModal(): void {
    this.goalsSub?.unsubscribe();
    this.isDetailModalOpen = false;
    this.selectedEmployeeForDetail = null;
    this.detailStats = null;
    this.goalDeadlines = [];
    this.detailAiSub?.unsubscribe();  
    this.detailWithAi = false;  
  }

  // ĐÃ THÊM: nút "Đánh giá KPI chi tiết" trong modal chi tiết
  reviewFromDetail(): void {
    const code = this.selectedEmployeeForDetail?.code;
    const emp = this.employees.find(e => e.code === code);
    this.closeDetailModal();
    if (emp) this.openReview([emp]);
  }

  ngOnDestroy(): void {
    this.goalsSub?.unsubscribe();
    this.alertSub?.unsubscribe();
    this.aiBgSub?.unsubscribe();
    this.detailAiSub?.unsubscribe();
  }
  detailAi = { 
    loading: false, 
    unavailable: false, 
    result: null as AiRiskResult | null, 
    shapBars: [] as ShapBar[] 
  };
  
  detailWithAi = false;   // true khi modal được mở từ nút trong khung AI cảnh báo

  private detailAiSub?: Subscription;
}