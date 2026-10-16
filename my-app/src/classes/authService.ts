import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { BehaviorSubject, Observable, forkJoin } from 'rxjs';
import { map, shareReplay } from 'rxjs/operators';
 
// Ba vai trò trong hệ thống, khớp với trường "role" trong các file JSON
export type Role = 'employee' | 'manager' | 'hr';
 
export interface User {
  id: string;
  username: string;
  password?: string;        // chỉ có trong file JSON, KHÔNG lưu vào phiên đăng nhập
  fullName: string;
  role: Role;
  department: string;
  managerId: string | null;
}
 
// Thư mục chứa 3 file JSON người dùng.
// Angular 17 trở xuống: 'assets/data'. Angular 18 trở lên (thư mục public/): 'data'
const DATA_PATH = 'datasets';
 
// Khóa lưu người đang đăng nhập trong sessionStorage (đóng tab là mất)
const SESSION_KEY = 'cpm_current_user';
 
// Mỗi vai trò sau khi đăng nhập sẽ vào trang nào (đổi cho khớp app-routing.module.ts)
const HOME_ROUTE: Record<Role, string> = {
  employee: '/app-employee-dashboard',
  manager: '/app-manager-dashboard',
  hr: '/app-hr-dashboard',
};
 
@Injectable({ providedIn: 'root' })
export class AuthService {
  // Danh sách toàn bộ người dùng, chỉ tải một lần rồi dùng lại
  private users$?: Observable<User[]>;
 
  // Người đang đăng nhập (null nếu chưa đăng nhập)
  private userSubject: BehaviorSubject<User | null>;
  readonly currentUser$: Observable<User | null>;
 
  constructor(private http: HttpClient) {
    this.userSubject = new BehaviorSubject<User | null>(this.readSession());
    this.currentUser$ = this.userSubject.asObservable();
  }
 
  // Người đang đăng nhập hiện tại (dùng ở các màn hình để lọc dữ liệu)
  get currentUser(): User | null {
    return this.userSubject.value;
  }
 
  isLoggedIn(): boolean {
    return this.userSubject.value !== null;
  }
 
  // Trang chủ tương ứng với vai trò
  homeRouteFor(role: Role): string {
    return HOME_ROUTE[role];
  }
 
  // Kiểm tra tên đăng nhập và mật khẩu. Trả về người dùng nếu đúng, null nếu sai
  login(username: string, password: string): Observable<User | null> {
    return this.loadUsers().pipe(
      map((users) => {
        const name = username.trim().toLowerCase();
        const found = users.find((u) => u.username === name && u.password === password);
        if (!found) {
          return null;
        }
 
        // Bỏ mật khẩu trước khi lưu vào phiên
        const safeUser: User = { ...found };
        delete safeUser.password;
 
        sessionStorage.setItem(SESSION_KEY, JSON.stringify(safeUser));
        this.userSubject.next(safeUser);
        return safeUser;
      })
    );
  }
 
  logout(): void {
    sessionStorage.removeItem(SESSION_KEY);
    this.userSubject.next(null);
  }
 
  // Đọc 3 file JSON, gộp thành một danh sách và nhớ lại kết quả
  private loadUsers(): Observable<User[]> {
    if (!this.users$) {
      this.users$ = forkJoin([
        this.http.get<User[]>(`${DATA_PATH}/employees.json`),
        this.http.get<User[]>(`${DATA_PATH}/managers.json`),
        this.http.get<User[]>(`${DATA_PATH}/hr.json`),
      ]).pipe(
        map(([employees, managers, hr]) => [...employees, ...managers, ...hr]),
        shareReplay(1)
      );
    }
    return this.users$;
  }
 
  // Khôi phục phiên đăng nhập khi người dùng tải lại trang
  private readSession(): User | null {
    try {
      const raw = sessionStorage.getItem(SESSION_KEY);
      return raw ? (JSON.parse(raw) as User) : null;
    } catch {
      return null;
    }
  }
}