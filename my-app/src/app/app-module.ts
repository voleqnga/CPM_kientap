import { NgModule, provideBrowserGlobalErrorListeners } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { HttpClientModule } from '@angular/common/http';
import { BrowserModule } from '@angular/platform-browser';

import { AppRoutingModule } from './app-routing-module';
import { App } from './app';
import { Contacts } from './contacts/contacts';
import { EmployeeDashboard } from './employee-dashboard/employee-dashboard';
import { ManagerDashboard } from './manager-dashboard/manager-dashboard';
import { HrDashboard } from './hr-dashboard/hr-dashboard';
import { UserLogin } from './user-login/user-login';

@NgModule({
  declarations: [App, Contacts, EmployeeDashboard, ManagerDashboard, HrDashboard, UserLogin],
  imports: [BrowserModule, FormsModule, HttpClientModule, AppRoutingModule],
  providers: [provideBrowserGlobalErrorListeners()],
  bootstrap: [App],
})
export class AppModule {}
