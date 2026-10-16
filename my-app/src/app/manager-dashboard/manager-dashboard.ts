import { ChangeDetectorRef, Component, DestroyRef, HostListener, OnDestroy, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Router } from '@angular/router';
import { AuthService, User } from '../../classes/authService';
import { DataService, TODAY } from '../../classes/data';
import { EmployeeSummary } from '../../classes/cpn';
import { TaskAssignmentService } from '../../services/task-assignment.service';
import { Subscription } from 'rxjs';


/* ==========================================================
   MODELS (tạm đặt tại đây — sau này gom vào models/*.ts dùng chung
   với dashboard.component.ts)
   Tên field snake_case khớp JSON mà API sẽ trả về.
   ========================================================== */

export interface UnifiedMetrics {
  actual_progress: number;   // Tiến độ thực tế (%)
  expected_progress: number; // Tiến độ kỳ vọng (%)
  overdue_tasks: number;     // Số việc quá hạn
  days_remaining: number;    // Số ngày còn lại
}

export type RiskLabel = 'High Risk' | 'Low Risk' | 'Normal'; // Nhãn của XGBoost

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
  risk_label: RiskLabel;       // Kết quả XGBoost
  feedback: string;            // nhận xét của quản lý ('' = chưa đánh giá)
  metrics: UnifiedMetrics;
  overdueItems: OverdueItem[];
  forecast: number;
}

export interface ShapReason {
  prefix: string;
  highlight: string;
  suffix: string;
}

export interface OverdueItem {
  goal: string;
  task: string;
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
  today = TODAY;

  constructor(
    private readonly router: Router,
    private readonly taskAssignmentService: TaskAssignmentService,
    private readonly authService: AuthService,
    private readonly dataService: DataService,
    private readonly changeDetector: ChangeDetectorRef
  ) {
    const currentUser = this.authService.currentUser;
    if (currentUser?.role === 'manager') {
      this.manager = { name: currentUser.fullName, position: 'Trưởng phòng' };
      this.dataService.getEmployeeSummaries(currentUser)
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe(summaries => {
          this.employeeSummaries = summaries;
          this.assignableEmployees = summaries.map(summary => summary.employee);
          this.employees = summaries.map(summary => this.toEmployee(summary));
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
          this.changeDetector.markForCheck();
        });
    } else {
      // ĐÃ THÊM: người dùng không phải manager thì đưa về trang đăng nhập
      void this.router.navigateByUrl('/app-user-login');
    }
  }

  private toEmployee(summary: EmployeeSummary): Employee {
    const employee = summary.employee;
    const risk = summary.latestRisk;
    const statusLabel = risk === 'High Risk'
      ? 'Rủi ro'
      : risk === 'Low Risk' || summary.avgActual < 80
        ? 'Cảnh báo'
        : summary.avgActual >= 90 ? 'Tốt' : 'Đạt';

    const overdueItems: OverdueItem[] = summary.activeGoals.flatMap(goal =>
      this.dataService.overdueTasksOf(goal).map(task => ({
        goal: goal.name,
        task: task.name,
        dueDate: task.dueDate,
        daysLate: Math.round((Date.parse(TODAY) - Date.parse(task.dueDate)) / 86400000)
      }))
    );
    const forecast = summary.avgExpected > 0
      ? Math.min(100, Math.round(summary.avgActual / summary.avgExpected * 100))
      : 100;

    return {
      code: employee.id,
      name: employee.fullName,
      initials: employee.fullName.split(/\s+/).slice(-2).map(part => part[0]).join('').toUpperCase(),
      jobTitle: 'Nhân viên',
      team: employee.department,
      teamName: employee.department,
      kpi: summary.avgActual,
      kpiTarget: 85,
      selfAssessment: `${summary.activeGoals.length} mục tiêu đang chạy · ${summary.completedGoals}/${summary.totalGoals} mục tiêu hoàn thành`,
      statusLabel,
      risk_label: risk,
      feedback: this.dataService.getFeedbacksOf(employee.id)[0]?.text ?? '',
      overdueItems,
      forecast,
      metrics: {
        actual_progress: summary.avgActual,
        expected_progress: summary.avgExpected,
        overdue_tasks: summary.overdueTotal,
        days_remaining: summary.activeGoals.length
          ? Math.min(...summary.activeGoals.map(goal => this.dataService.daysRemaining(goal)))
          : 0
      }
    };
  }

  private updateSummary(): void {
    const count = this.employees.length;
    const achievedCount = this.employees.filter(employee => employee.kpi >= employee.kpiTarget).length;
    const atRiskCount = this.employees.filter(employee => employee.risk_label !== 'Normal').length;
    this.summary = {
      totalStaff: count,
      teamCount: new Set(this.employees.map(employee => employee.team)).size,
      attendance: `${count} nhân viên theo dữ liệu`,
      avgKpi: count ? Math.round(this.employees.reduce((sum, employee) => sum + employee.kpi, 0) / count) : 0,
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
    logo: 'https://lh3.googleusercontent.com/aida/AEtjO1V1jaUxaQzWm3n-04M5cPoNGnD2ucdXITFrC_P9iK_mQ-ZadikGW4kQ9oAhMAI59rd2myGd0mIAKqZiD8QzeJlSTEFrXRr9lvo3DSjE-UxELisb8Jhlvgpmcz3oiMmph2GPCDT44OPDzh_jA2OkvS2bcDxgztEzzvK2NR0i6-MQpSF8zYRXymkp1IEMUfFmk6xTEhh9lRvzVAtgA9SfgJxu-IpJvo0oP7S4L0tJJ7SkHkGh1bYw9LYe1w',
    avatar: 'https://lh3.googleusercontent.com/aida-public/AB6AXuB8HHSnBhHBSsMSqqLXeCi87hbXGCVLiq82Ns7dWyDz4Cv83l3hQFctz0hezwWt32WPPnYtyGUqllIll8lepvSTeQa8doKX5BwMY1vsh0lXMEfFikzELUFzCoKsHmdK5bmzXbovq7DDAaQArnXmYhTCZe9ohNxB31-_25_ZHzWhJTXzS3tynXGyY0uBF6myLyQ2ahf1J15pM2sJ4V8c9k2ZyAxC_6sCz6fsUHoP5tZeFkZExtHy-kMr'
  };

  /* ---------- MOCK: người dùng & bối cảnh ---------- */
  manager = { name: '', position: 'Trưởng phòng' };

  pageInfo = {
    location: 'Văn phòng Trụ sở Long Thành',
    title: 'Quản lý Phòng Kinh doanh DONASA - Báo cáo & Đánh giá Nhóm Dự án & Đại lý',
    description:
      'Giám sát hiệu suất bán hàng, tiến độ thu hồi công nợ và phê duyệt KPI tháng 10/2024 của các nhóm kinh doanh.'
  };

  /* ---------- Bộ lọc (Template-Driven + [(ngModel)]) ---------- */
  teamOptions = [
    { value: 'all', label: 'Tất cả phòng ban' }
  ];
  periodOptions = [
    { value: '2024-10', label: 'Tháng 10/2024' },
    { value: '2024-09', label: 'Tháng 09/2024' },
    { value: '2024-08', label: 'Tháng 08/2024' }
  ];
  filters = {
    team: 'all',
    period: '2024-10',
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

  /* ---------- MOCK: kết quả AI (XGBoost + SHAP + Gemini) ---------- */
  aiAlert = {
    engineLabel: 'Hệ thống phân tích dữ liệu tự động từ CRM và phần mềm công nợ kế toán',
    modelConfidence: '94.8%',
    employee: null as Employee | null,
    reasons: [] as ShapReason[],   // ĐÃ SỬA: không còn gõ cứng, được sinh trong selectAlert()
    coaching: ''                   // ĐÃ SỬA: không còn gõ cứng, được sinh trong selectAlert()
  };

  /* ---------- Dữ liệu bảng ---------- */
  employees: Employee[] = [];

  /* ---------- Modal chi tiết nhân viên (giống HR) ---------- */
  selectedEmployeeForDetail: DetailEmployee | null = null;
  selectedSummary: EmployeeSummary | null = null;
  employeeSummaries: EmployeeSummary[] = [];
  goalDeadlines: number[] = [];      // số ngày còn lại của từng goal
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

  // AI tạo feedback từ evidence (tiến độ, kỳ vọng, việc quá hạn). TODO: thay bằng gọi API Gemini
  generateAi(): void {
    const t = this.review.targets;
    if (!t.length) return;
    const avg = (f: (e: Employee) => number) => Math.round(t.reduce((s, e) => s + f(e), 0) / t.length);
    const actual = avg(e => e.metrics.actual_progress);
    const expected = avg(e => e.metrics.expected_progress);
    const overdue = t.reduce((s, e) => s + e.metrics.overdue_tasks, 0);
    const gap = expected - actual;
    const who = t.length === 1 ? t[0].name : `cả nhóm (${t.length} nhân viên)`;

    this.review.ai =
      `Trong kỳ này ${who} đạt ${actual}% tiến độ, so với kỳ vọng ${expected}%` +
      (gap > 0 ? ` (chậm ${gap}%)` : ' (đạt/vượt kỳ vọng)') +
      `, có ${overdue} việc quá hạn. ` +
      (gap > 5 || overdue > 0
        ? 'Đề xuất rà soát lại các việc quá hạn, ưu tiên việc có trọng số lớn và trao đổi 1-1 để gỡ vướng mắc.'
        : 'Tiếp tục duy trì nhịp độ hiện tại và có thể nhận thêm mục tiêu thử thách hơn.');
  }

  applyAi(): void {
    this.review.text = this.review.ai;
  }

  sendReview(): void {
    const text = this.review.text.trim();
    if (!text) return;
    this.review.targets.forEach(e => {
      e.feedback = text;
      this.dataService.saveFeedback(e.code, text, this.manager.name);
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

  // Việc cùng bị trễ ở từ 2 người trở lên = vấn đề chung của nhóm
  get teamPatterns(): { task: string; count: number }[] {
    const map = new Map<string, number>();
    this.riskQueue.forEach(e =>
      new Set(e.overdueItems.map(i => i.task)).forEach(t => map.set(t, (map.get(t) ?? 0) + 1)));
    return [...map]
      .filter(([, n]) => n >= 2)
      .map(([task, count]) => ({ task, count }))
      .sort((a, b) => b.count - a.count);
  }

  // ĐÃ SỬA: sinh lại SHAP + Coaching theo nhân viên đang chọn
  // TODO: thay bằng kết quả SHAP thật từ API khi có
  selectAlert(e: Employee): void {
    this.aiAlert.employee = e;

    const gap = Math.max(0, Math.round(e.metrics.expected_progress - e.metrics.actual_progress));
    this.aiAlert.reasons = [
      { prefix: 'Số việc quá hạn là ', highlight: `${e.metrics.overdue_tasks} việc`, suffix: '.' },
      { prefix: 'Tiến độ thực tế thấp hơn kỳ vọng ', highlight: `${gap}%`, suffix: '.' }
    ];

    this.aiAlert.coaching = e.metrics.overdue_tasks > 0
      ? `Đề xuất tổ chức buổi kèm cặp 1-1 với ${e.name} để rà soát ${e.metrics.overdue_tasks} việc quá hạn, ` +
        'ưu tiên các việc có trọng số lớn nhất và hỗ trợ gỡ vướng mắc trước cuối tuần.'
      : `Đề xuất trao đổi 1-1 với ${e.name} để tìm nguyên nhân tiến độ chậm hơn kế hoạch ${gap}% ` +
        'và điều chỉnh kế hoạch thực hiện cho phần còn lại của kỳ.';
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

  /** Chênh lệch giữa kỳ vọng và thực tế (điểm %) */
  get detailGap(): number {
    return this.selectedSummary
      ? this.selectedSummary.avgExpected - this.selectedSummary.avgActual
      : 0;
  }

  viewProfile(emp: Employee): void {
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
    this.selectedSummary = summary;
    this.goalDeadlines = [];
    this.goalsLoading = true;
    this.isDetailModalOpen = true;

    this.goalsSub?.unsubscribe();
    this.goalsSub = this.dataService.getGoalsOf(emp.code)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: goals => {
          this.goalDeadlines = goals.map(goal => this.dataService.daysRemaining(goal));
          this.goalsLoading = false;
          this.changeDetector.markForCheck();
        },
        error: () => {
          this.goalsLoading = false;
          this.changeDetector.markForCheck();
        }
      });
  }

  closeDetailModal(): void {
    this.goalsSub?.unsubscribe();
    this.isDetailModalOpen = false;
    this.selectedEmployeeForDetail = null;
    this.selectedSummary = null;
    this.goalDeadlines = [];
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
  }
}