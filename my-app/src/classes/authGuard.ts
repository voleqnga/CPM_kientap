
import { Injectable } from '@angular/core';
import { ActivatedRouteSnapshot, CanActivate, Router, UrlTree } from '@angular/router';
import { AuthService, Role } from './authService';
 
// Cách dùng trong app-routing.module.ts:
//   { path: 'manager-dashboard', component: ManagerDashboardComponent,
//     canActivate: [AuthGuard], data: { roles: ['manager'] } }
@Injectable({ providedIn: 'root' })
export class AuthGuard implements CanActivate {
  constructor(private auth: AuthService, private router: Router) {}
 
  canActivate(route: ActivatedRouteSnapshot): boolean | UrlTree {
    const user = this.auth.currentUser;
 
    // Chưa đăng nhập: về trang đăng nhập
    if (!user) {
      return this.router.createUrlTree(['/app-user-login']);
    }
 
    // Sai vai trò: đưa về trang chủ của vai trò hiện tại
    const allowed = route.data['roles'] as Role[] | undefined;
    if (allowed && !allowed.includes(user.role)) {
      return this.router.createUrlTree([this.auth.homeRouteFor(user.role)]);
    }
 
    return true;
  }
}
 