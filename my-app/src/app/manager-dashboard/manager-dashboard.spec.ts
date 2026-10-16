import { ComponentFixture, TestBed } from '@angular/core/testing';

import { ManagerDashboard } from './manager-dashboard';

describe('ManagerDashboard', () => {
  let component: ManagerDashboard;
  let fixture: ComponentFixture<ManagerDashboard>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      declarations: [ManagerDashboard],
    }).compileComponents();

    fixture = TestBed.createComponent(ManagerDashboard);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
