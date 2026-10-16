import { NgModule } from '@angular/core';
import { RouterModule, Routes } from '@angular/router';
import { EmployeeDashboard } from './employee-dashboard/employee-dashboard';
import { ManagerDashboard } from './manager-dashboard/manager-dashboard';
import { HrDashboard } from './hr-dashboard/hr-dashboard';
import { UserLogin } from './user-login/user-login';
import { AuthGuard } from '../classes/authGuard';

const routes: Routes = [
  { path: 'app-employee-dashboard', component: EmployeeDashboard, canActivate: [AuthGuard], data: { roles: ['employee'] } }, 
  { path: 'app-manager-dashboard', component: ManagerDashboard, canActivate: [AuthGuard], data: { roles: ['manager'] } }, 
  { path: 'app-hr-dashboard', component: HrDashboard, canActivate: [AuthGuard], data: { roles: ['hr'] } }, 
  { path: 'app-user-login', component: UserLogin },
  { path: '', redirectTo: '/app-user-login', pathMatch: 'full' } // Mặc định vào web là trỏ thẳng tới đây
];

@NgModule({
  imports: [RouterModule.forRoot(routes)],
  exports: [RouterModule]
})
export class AppRoutingModule { }
