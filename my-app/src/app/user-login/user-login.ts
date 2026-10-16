import { Component } from '@angular/core';
import { Router } from '@angular/router';
import { AuthService } from '../../classes/authService';

@Component({
  selector: 'app-user-login',
  standalone: false,
  templateUrl: './user-login.html',
  styleUrl: './user-login.css',
})
export class UserLogin {
  username = '';
  password = '';
 
  showPassword = false;
  submitted = false;
  loading = false;
  errorMessage = '';
 
  // Tài khoản demo: bấm vào để điền sẵn (mật khẩu mock chung là 123456)
  demoAccounts = [
    { label: 'Nhân viên', username: 'bus01' },
    { label: 'Quản lý', username: 'mgr01' },
    { label: 'HR', username: 'hr01' },
  ];
 
  constructor(private auth: AuthService, private router: Router) {
    // Đã đăng nhập rồi thì vào thẳng trang của vai trò đó
    const user = this.auth.currentUser;
    if (user) {
      this.router.navigate([this.auth.homeRouteFor(user.role)]);
    }
  }
 
  fillDemo(username: string): void {
    this.username = username;
    this.password = '123456';
    this.errorMessage = '';
  }
 
  togglePassword(): void {
    this.showPassword = !this.showPassword;
  }
 
  onSubmit(): void {
    this.submitted = true;
    this.errorMessage = '';
 
    // Thiếu thông tin thì để template hiện thông báo từng ô
    if (!this.username.trim() || !this.password) {
      return;
    }
 
    this.loading = true;
    this.auth.login(this.username, this.password).subscribe({
      next: (user) => {
        this.loading = false;
        if (!user) {
          this.errorMessage = 'Tên đăng nhập hoặc mật khẩu chưa đúng';
          return;
        }
        this.router.navigate([this.auth.homeRouteFor(user.role)]);
      },
      error: () => {
        this.loading = false;
        this.errorMessage = 'Không tải được dữ liệu người dùng. Thử lại sau';
      },
    });
  }
}
