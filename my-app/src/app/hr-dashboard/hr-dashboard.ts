import { ChangeDetectorRef, Component, DestroyRef, HostListener, OnInit, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Router } from '@angular/router';
import { AuthService } from '../../classes/authService';
import { DataService } from '../../classes/data';
import { DepartmentSummary, EmployeeSummary } from '../../classes/cpn';
import { Subscription } from 'rxjs';



/* ==========================================================
   MODELS (tạm đặt tại đây — sau này gom vào models/*.ts dùng chung)
   ========================================================== */
 
export type RiskLabel = 'High Risk' | 'Low Risk' | 'Normal'; // Nhãn của XGBoost
export type KpiStatus = 'Tốt' | 'Đạt' | 'Cảnh báo' | 'Rủi ro';
export type DeptKey = string;
 
export interface NavItem {
  path: string;
  label: string;
  icon: string;
}
 
export interface MetricCard {
  caption: string;
  icon: string;
  iconTone: 'soft' | 'good' | 'secondary' | 'error' | 'tertiary';
  value: string;
  valueTone: 'default' | 'primary' | 'error';
  sub: string;
  footIcon: string;
  footText: string;
  footTone: 'muted' | 'good' | 'error';
}
 
export interface DepartmentKpi {
  label: string;
  value: number;
  tone: 'primary' | 'container' | 'tertiary' | 'tint' | 'error';
  needsImprovement?: boolean;
}
 
export interface TextSegment {
  text: string;
  strong?: boolean;
}
 
export interface AiInsight {
  icon: string;
  tone: 'error' | 'primary' | 'good';
  title: string;
  segments: TextSegment[];
}
 
export interface Employee {
  code: string;
  name: string;
  initials: string;
  username: string;
  department: DeptKey;      // dùng cho bộ lọc
  departmentLabel: string;  // hiển thị
  jobTitle: string;
  kpi: number;              // %
  status: KpiStatus;
  risk_label: RiskLabel;    // kết quả XGBoost
}
 
export interface NewEmployeeForm {
  fullName: string;
  phone: string;
  dob: string;
  gender: 'Nam' | 'Nữ';
  department: string;
  jobTitle: string;
  workgroup: string;
  manager: string;
  startDate: string;
  workMode: string;
  username: string;
  password: string;
  appRole: string;
}
 
export interface RoleOption {
  value: string;
  label: string;
  desc: string;
}

@Component({
  selector: 'app-hr-dashboard',
  standalone: false,
  templateUrl: './hr-dashboard.html',
  styleUrl: './hr-dashboard.css',
})
export class HrDashboard implements OnInit {
  /* ---------- Điều hướng, vai trò & sidebar đóng/mở ---------- */
  navItems: NavItem[] = [
    { path: '/tong-quan',                     label: 'Tổng quan',                   icon: 'dashboard' },
    { path: '/kpi-cua-toi',                   label: 'KPI của tôi',                 icon: 'track_changes' },
    { path: '/tien-do-va-bao-cao',            label: 'Tiến độ & Báo cáo',           icon: 'insights' },
    { path: '/tu-danh-gia',                   label: 'Tự đánh giá',                 icon: 'rate_review' },
    { path: '/nhan-xet-va-coaching-ai',       label: 'Nhận xét & Coaching AI',      icon: 'psychology' },
    { path: '/quan-ly-nhan-su-va-phan-quyen', label: 'Quản lý Nhân sự & Phân quyền', icon: 'group' },
    { path: '/cai-dat',                       label: 'Cài đặt',                     icon: 'settings' }
  ];
  roles: string[] = ['Nhân viên', 'Quản lý', 'HR Nhân sự'];
  selectedRole = 'HR Nhân sự';

  private readonly destroyRef = inject(DestroyRef);

  constructor(
    private readonly router: Router,
    private readonly authService: AuthService,
    private readonly dataService: DataService,
    private readonly changeDetector: ChangeDetectorRef
  ) {}

  private applyEmployeeSummaries(summaries: EmployeeSummary[]): void {
    this.employeeSummaries = summaries;
    this.employees = summaries.map(summary => {
      const employee = summary.employee;
      const risk = summary.latestRisk;
      const status: KpiStatus = risk === 'High Risk'
        ? 'Rủi ro'
        : risk === 'Low Risk'
          ? 'Cảnh báo'
          : summary.avgActual >= 90 ? 'Tốt' : 'Đạt';

      return {
        code: employee.id,
        name: employee.fullName,
        initials: employee.fullName.split(/\s+/).slice(-2).map(part => part[0]).join('').toUpperCase(),
        username: employee.username,
        department: employee.department,
        departmentLabel: employee.department,
        jobTitle: employee.role === 'employee' ? 'Nhân viên' : employee.role,
        kpi: summary.avgActual,
        status,
        risk_label: risk
      };
    });
    this.summary.totalStaff = this.employees.length;
    this.departmentOptions = [
      { value: 'ALL', label: 'Tất cả phòng ban' },
      ...Array.from(new Set(this.employees.map(employee => employee.department)))
        .map(department => ({ value: department, label: department }))
    ];
    if (!this.departmentOptions.some(option => option.value === this.filters.department)) {
      this.filters.department = 'ALL';
    }

    const total = summaries.length;
    const high = summaries.filter(summary => summary.latestRisk === 'High Risk').length;
    const low = summaries.filter(summary => summary.latestRisk === 'Low Risk').length;
    const normal = summaries.filter(summary => summary.latestRisk === 'Normal').length;
    const percent = (count: number): number => total ? Math.round(count / total * 100) : 0;
    this.riskDistribution = {
      highRisk: { ...this.riskDistribution.highRisk, count: high, value: percent(high) },
      lowRisk: { ...this.riskDistribution.lowRisk, count: low, value: percent(low) },
      normal: { ...this.riskDistribution.normal, count: normal, value: percent(normal) }
    };

    const completedEmployees = summaries.filter(summary => summary.totalGoals > 0 && summary.completedGoals === summary.totalGoals).length;
    const employeesWithActiveGoals = summaries.filter(summary => summary.activeGoals.length > 0).length;
    const averageKpi = total ? summaries.reduce((sum, summary) => sum + summary.avgActual, 0) / total : 0;
    const atRiskEmployees = high + low;
    const belowTargetEmployees = summaries.filter(summary => summary.avgActual < 85).length;
    this.metricCards = [
      { caption: 'Tổng nhân viên', icon: 'groups', iconTone: 'soft', value: String(total), valueTone: 'default', sub: 'Hồ sơ trong employees.json', footIcon: 'corporate_fare', footText: `${this.departmentOptions.length - 1} phòng ban`, footTone: 'muted' },
      { caption: 'Có mục tiêu đang chạy', icon: 'how_to_reg', iconTone: 'good', value: String(employeesWithActiveGoals), valueTone: 'default', sub: 'Có goal chưa hoàn thành', footIcon: 'check_circle', footText: `Trong ${total} nhân viên`, footTone: 'good' },
      { caption: 'KPI thực tế trung bình', icon: 'speed', iconTone: 'secondary', value: `${averageKpi.toFixed(1)}%`, valueTone: 'primary', sub: 'Từ trọng số task đã xong', footIcon: 'trending_up', footText: 'Tính từ goals.json', footTone: 'muted' },
      { caption: 'Cần chú ý', icon: 'warning', iconTone: 'error', value: String(high + low), valueTone: 'error', sub: 'Theo gap/task quá hạn', footIcon: 'emergency', footText: `${high} nguy cơ cao · ${low} nguy cơ thấp`, footTone: 'error' },
      { caption: 'Hoàn thành tất cả goal', icon: 'task_alt', iconTone: 'tertiary', value: `${percent(completedEmployees)}%`, valueTone: 'default', sub: `${completedEmployees}/${total} nhân viên`, footIcon: 'pie_chart', footText: 'Từ trạng thái goals.json', footTone: 'muted' }
    ];

    const departments: DepartmentSummary[] = this.dataService.groupByDepartment(summaries);
    const tones: DepartmentKpi['tone'][] = ['primary', 'container', 'tertiary', 'tint', 'error'];
    this.departmentKpis = departments.map((department, index) => ({
      label: department.department,
      value: department.avgActual,
      tone: tones[index % tones.length],
      needsImprovement: department.avgActual < 85
    }));
    this.aiPlanning.description = `Tổng hợp ${total} hồ sơ trong employees.json cùng tiến độ goal/task và check-in hiện có.`;
    this.aiPlanning.insights[0].segments = [
      { text: 'Có ' },
      { text: `${atRiskEmployees} nhân viên`, strong: true },
      { text: ` đang được phân loại rủi ro (${high} cao, ${low} thấp) từ gap, task quá hạn và deadline.` }
    ];
    this.aiPlanning.insights[1].segments = [
      { text: 'Hiện có ' },
      { text: `${belowTargetEmployees} nhân viên`, strong: true },
      { text: ' có actual progress dưới ngưỡng tham chiếu 85% trong các goal đang chạy.' }
    ];
    const departmentsMeetingTarget = this.departmentKpis.filter(department => department.value >= 85).length;
    this.chartInfo = {
      subtitle: 'Actual progress tính từ trọng số task đã hoàn thành',
      badge: `${departments.length} phòng ban`,
      benchmark: '85%',
      summary: `${departmentsMeetingTarget}/${departments.length} phòng ban đạt ngưỡng`
    };

    const overdueCount = summaries.reduce((sum, summary) => sum + summary.overdueTotal, 0);
    const behindCount = summaries.filter(summary => summary.avgExpected - summary.avgActual >= 5).length;
    const nearDeadlineCount = summaries.filter(summary =>
      summary.activeGoals.some(goal => this.dataService.daysRemaining(goal) < 10)
    ).length;
    const factors = [overdueCount, behindCount, nearDeadlineCount];
    const factorTotal = factors.reduce((sum, value) => sum + value, 0);
    this.shapBottlenecks = [
      { id: 1, reason: 'Task đang quá hạn', percentage: factorTotal ? Math.round(factors[0] / factorTotal * 100) : 0, detail: `${overdueCount} task quá hạn trong nhóm nhân viên đang theo dõi` },
      { id: 2, reason: 'Actual chậm hơn Expected', percentage: factorTotal ? Math.round(factors[1] / factorTotal * 100) : 0, detail: `${behindCount} nhân viên có gap từ 5 điểm % trở lên` },
      { id: 3, reason: 'Goal gần deadline', percentage: factorTotal ? Math.round(factors[2] / factorTotal * 100) : 0, detail: `${nearDeadlineCount} nhân viên có goal còn dưới 10 ngày` }
    ];
  }

  ngOnInit(): void {
    const user = this.authService.currentUser;
    if (!user || user.role !== 'hr') return;

    this.currentUser = { name: user.fullName, position: user.department };
    this.dataService.getEmployeeSummaries(user)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(summaries => {
        this.applyEmployeeSummaries(summaries);
        this.changeDetector.markForCheck();
      });
  }

  employeeSummaries: EmployeeSummary[] = [];

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
 
  /** Esc: đóng sidebar và modal */
  @HostListener('document:keydown.escape')
  onEscape(): void {
    this.sidebarOpen = false;
    this.showAddModal = false;
  }
 
  assets = {
    logo: 'https://lh3.googleusercontent.com/aida/AEtjO1V1jaUxaQzWm3n-04M5cPoNGnD2ucdXITFrC_P9iK_mQ-ZadikGW4kQ9oAhMAI59rd2myGd0mIAKqZiD8QzeJlSTEFrXRr9lvo3DSjE-UxELisb8Jhlvgpmcz3oiMmph2GPCDT44OPDzh_jA2OkvS2bcDxgztEzzvK2NR0i6-MQpSF8zYRXymkp1IEMUfFmk6xTEhh9lRvzVAtgA9SfgJxu-IpJvo0oP7S4L0tJJ7SkHkGh1bYw9LYe1w',
    avatar: 'https://lh3.googleusercontent.com/aida-public/AB6AXuB8HHSnBhHBSsMSqqLXeCi87hbXGCVLiq82Ns7dWyDz4Cv83l3hQFctz0hezwWt32WPPnYtyGUqllIll8lepvSTeQa8doKX5BwMY1vsh0lXMEfFikzELUFzCoKsHmdK5bmzXbovq7DDAaQArnXmYhTCZe9ohNxB31-_25_ZHzWhJTXzS3tynXGyY0uBF6myLyQ2ahf1J15pM2sJ4V8c9k2ZyAxC_6sCz6fsUHoP5tZeFkZExtHy-kMr'
  };
 
  currentUser = { name: '', position: '' };
 
  pageInfo = {
    tag: 'Phân hệ Quản trị Nguồn Nhân lực CPM',
    title: 'Phòng Nhân sự DONASA - Báo cáo Tổng thể & Quản trị Nhân lực Khối Văn phòng',
    description:
      'Giám sát năng lực nhân viên khối văn phòng, theo dõi biến động KPI theo chu kỳ check-in và điều phối nguồn lực theo thời gian thực.'
  };
 
  metricCards: MetricCard[] = [];

  riskDistribution = {
    highRisk: { label: 'Nguy cơ cao', value: 0, count: 0, color: '#ef4444' },
    lowRisk: { label: 'Nguy cơ thấp', value: 0, count: 0, color: '#f59e0b' },
    normal: { label: 'Bình thường', value: 0, count: 0, color: '#10b981' }
  };

  shapBottlenecks: { id: number; reason: string; percentage: number; detail: string }[] = [];

  get riskTotal(): number {
    return this.riskDistribution.highRisk.count
      + this.riskDistribution.lowRisk.count
      + this.riskDistribution.normal.count;
  }

  get pieChartGradient(): string {
    const highEnd = this.riskDistribution.highRisk.value;
    const lowEnd = highEnd + this.riskDistribution.lowRisk.value;
    return `conic-gradient(${this.riskDistribution.highRisk.color} 0% ${highEnd}%, ${this.riskDistribution.lowRisk.color} ${highEnd}% ${lowEnd}%, ${this.riskDistribution.normal.color} ${lowEnd}% 100%)`;
  }
 
  /* ---------- MOCK: KPI theo nhóm/phòng ban ---------- */
  chartInfo = { subtitle: 'Đang tải dữ liệu nhân sự', badge: '0 phòng ban', benchmark: '85%', summary: '0/0 phòng ban đạt chỉ tiêu' };
 
  departmentKpis: DepartmentKpi[] = [];
 
  /* ---------- MOCK: AI hoạch định nhân sự (XGBoost + SHAP + Gemini) ---------- */
  aiPlanning = {
    eyebrow: 'Trợ lý Chiến lược Nhân sự',
    title: 'AI Phát hiện xu hướng & Hoạch định',
    statusLabel: 'Đang phân tích',
    description:
      'Dữ liệu đối chiếu từ lịch sử check-in hằng tuần, nhật ký cập nhật CRM và biên bản đánh giá tháng 10/2024.',
    insights: [
      {
        icon: 'trending_down', tone: 'error',
        title: 'Cảnh báo suy giảm hiệu suất liên tục',
        segments: [
          { text: 'Phát hiện ' },
          { text: '6 nhân viên', strong: true },
          { text: ' có xu hướng giảm KPI trong 2 tháng gần đây (chủ yếu tập trung tại nhóm ' },
          { text: 'Công nợ & Thu hồi và Đại lý & Phân phối', strong: true },
          { text: ').' }
        ]
      },
      {
        icon: 'person_search', tone: 'primary',
        title: 'Dự báo tải trọng & Nhu cầu nhân sự',
        segments: [
          { text: 'Nhóm Thống kê & Báo cáo đang ' },
          { text: 'thiếu hụt 2 nhân sự', strong: true },
          { text: ' để kịp tiến độ chốt số liệu cuối Quý 4 và báo cáo doanh thu dự án.' }
        ]
      },
      {
        icon: 'published_with_changes', tone: 'good',
        title: 'Đề xuất giải pháp hành động thông minh',
        segments: [
          { text: 'Kích hoạt phương án ' },
          { text: 'điều động luân chuyển nội bộ', strong: true },
          { text: ' từ nhóm Kế toán tổng hợp sang Thống kê; đồng thời lên lịch đào tạo kỹ năng đàm phán công nợ cho nhóm Đại lý.' }
        ]
      }
    ] as AiInsight[]
  };
 
  summary = { totalStaff: 0 };
  employees: Employee[] = [];
 
  /* ---------- Bộ lọc (Template-Driven + [(ngModel)]) ---------- */
  departmentOptions = [
    { value: 'ALL',        label: 'Tất cả phòng ban' },
    { value: 'Kinh doanh', label: 'Kinh doanh (Business)' },
    { value: 'R&D',        label: 'R&D Kỹ thuật' },
    { value: 'Kế toán',    label: 'Kế toán & Thống kê' }
  ];
  statusOptions = [
    { value: 'ALL',      label: 'Tất cả trạng thái' },
    { value: 'Tốt',      label: 'Tốt (>90%)' },
    { value: 'Đạt',      label: 'Đạt (80-89%)' },
    { value: 'Cảnh báo', label: 'Cảnh báo (70-79%)' },
    { value: 'Rủi ro',   label: 'Rủi ro (<70%)' }
  ];
  filters = { search: '', department: 'ALL', status: 'ALL' };
 
  /** Lọc đơn giản theo từ khóa + phòng ban + trạng thái. Khi có API sẽ chuyển sang Service. */
  get filteredEmployees(): Employee[] {
    const keyword = this.filters.search.trim().toLowerCase();
    return this.employees.filter(e =>
      (!keyword || e.name.toLowerCase().includes(keyword) || e.code.toLowerCase().includes(keyword)) &&
      (this.filters.department === 'ALL' || e.department === this.filters.department) &&
      (this.filters.status === 'ALL' || e.status === this.filters.status)
    );
  }
 
  /* ---------- Phân trang (mock) ---------- */
  pages: number[] = [1, 2, 3, 4, 5, 6];
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
     MODAL "THÊM NHÂN VIÊN MỚI" — Template-Driven Form
     ========================================================== */
  showAddModal = false;
 
  nextEmployeeCode = 'DNS-1358';
 
  departmentChoices: string[] = [
    'Phòng Kinh doanh (Business Dept.)',
    'Phòng R&D Kỹ thuật',
    'Phòng Kế toán & Thống kê'
  ];
  jobTitleChoices: string[] = [
    'Chuyên viên kinh doanh',
    'Chuyên viên R&D',
    'Kế toán viên',
    'Chuyên viên thống kê',
    'Trưởng nhóm'
  ];
  managerChoices: string[] = [
    'Lê Hoàng Nam (Trưởng phòng Kinh doanh)',
    'Trần Đình Trọng (Trưởng phòng R&D)',
    'Nguyễn Hoàng Minh (Kế toán trưởng)'
  ];
  workModeChoices: string[] = [
    'Hành chính (08:00 - 17:00)',
    'Hybrid (2 ngày làm việc từ xa/tuần)',
    'Linh hoạt (theo tiến độ dự án)'
  ];
  roleChoices: RoleOption[] = [
    { value: 'Nhân viên', label: 'Nhân viên',          desc: 'Xem KPI & Tự đánh giá' },
    { value: 'Quản lý',   label: 'Quản lý / Trưởng phòng', desc: 'Chấm KPI & Duyệt đánh giá' },
    { value: 'HR',        label: 'HR / Nhân sự tổng',   desc: 'Hoạch định & Toàn quyền hồ sơ' }
  ];
 
  newEmployee: NewEmployeeForm = this.createEmptyForm();
 
  private createEmptyForm(): NewEmployeeForm {
    return {
      fullName: '',
      phone: '',
      dob: '1992-05-18',
      gender: 'Nam',
      department: this.departmentChoices[0],
      jobTitle: this.jobTitleChoices[0],
      workgroup: '',
      manager: this.managerChoices[0],
      startDate: '2024-11-01',
      workMode: this.workModeChoices[0],
      username: 'dns_1358',
      password: 'Donasa@2024',
      appRole: 'Nhân viên'
    };
  }
 
  openAddModal(): void {
    this.newEmployee = this.createEmptyForm();
    this.showAddModal = true;
  }
 
  closeAddModal(): void {
    this.showAddModal = false;
  }
 
  /** TODO: thay bằng this.employeeService.create(this.newEmployee).subscribe(...) */
  submitNewEmployee(): void {
    this.toastMessage = `Thêm nhân viên mới "${this.newEmployee.fullName}" thành công vào hệ thống CPM!`;
    this.closeAddModal();
    this.showToast();
  }
 
  /* ---------- Toast thông báo ---------- */
  toastVisible = false;
  toastMessage = '';
  private toastTimer: ReturnType<typeof setTimeout> | null = null;
 
  showToast(): void {
    this.toastVisible = true;
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => (this.toastVisible = false), 4000);
  }
 
  hideToast(): void {
    this.toastVisible = false;
  }
 
  ngOnDestroy(): void {
    if (this.toastTimer) clearTimeout(this.toastTimer);
  }
 
  /* ---------- Hành động khác (mock) ---------- */
  exportKpi(): void {
    alert('Đang xuất dữ liệu KPI tháng 10/2024...');
  }
 
// ---- Modal chi tiết nhân viên ----
isDetailModalOpen = false;
selectedEmployeeForDetail: Employee | null = null;
selectedSummary: EmployeeSummary | null = null;
goalDeadlines: number[] = [];      // số ngày còn lại của từng goal
goalsLoading = false;
private goalsSub?: Subscription;

/** Chênh lệch giữa kỳ vọng và thực tế (điểm %) */
get detailGap(): number {
  return this.selectedSummary
    ? this.selectedSummary.avgExpected - this.selectedSummary.avgActual
    : 0;
}

viewProfile(emp: Employee): void {
  this.selectedEmployeeForDetail = emp;
  this.selectedSummary =
    this.employeeSummaries.find(s => s.employee.id === emp.code) ?? null;
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
 
  
 
  onAiAction(action: 'roadmap' | 'apply'): void {
    alert(action === 'roadmap'
      ? 'Mở lộ trình chi tiết do AI đề xuất.'
      : 'Đã áp dụng đề xuất AI (mock - sẽ nối API sau).');
  }
}
 
