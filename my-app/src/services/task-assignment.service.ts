import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';

export interface TaskAssignment {
  id: string;
  employeeId: string;
  employeeName: string;
  name: string;
  description: string;
  deadline: string;
  assignedBy: string;
  status: 'pending' | 'accepted';
}

@Injectable({ providedIn: 'root' })
export class TaskAssignmentService {
  private readonly storageKey = 'cpm_task_assignments';
  private readonly tasksSubject = new BehaviorSubject<TaskAssignment[]>(this.readTasks());
  readonly tasks$ = this.tasksSubject.asObservable();
  private nextTaskId = 1;

  constructor() {
    // Tab khác ghi localStorage -> tab này đọc lại và phát cho component
    if (typeof window !== 'undefined') {
      window.addEventListener('storage', event => {
        if (event.key === this.storageKey) {
          this.tasksSubject.next(this.readTasks());
        }
      });
    }
  }

  get tasks(): TaskAssignment[] {
    return this.tasksSubject.value;
  }

  assignTask(task: Omit<TaskAssignment, 'id' | 'status'>): void {
    const assignment: TaskAssignment = {
      ...task,
      id: `assigned-task-${Date.now()}-${this.nextTaskId++}`,
      status: 'pending'
    };

    // Đọc bản MỚI NHẤT từ localStorage trước khi ghi, tránh ghi đè task của tab khác
    this.updateTasks([...this.readTasks(), assignment]);
  }

  acceptTask(taskId: string, employeeId: string): void {
    this.updateTasks(this.readTasks().map(task =>
      task.id === taskId && task.employeeId === employeeId && task.status === 'pending'
        ? { ...task, status: 'accepted' as const }
        : task
    ));
  }

  private updateTasks(tasks: TaskAssignment[]): void {
    this.tasksSubject.next(tasks);
    try {
      localStorage.setItem(this.storageKey, JSON.stringify(tasks));
    } catch {
      // localStorage bị chặn hoặc đầy: vẫn giữ dữ liệu trong bộ nhớ phiên hiện tại
    }
  }

  private readTasks(): TaskAssignment[] {
    try {
      const stored = localStorage.getItem(this.storageKey);
      return stored ? JSON.parse(stored) as TaskAssignment[] : [];
    } catch {
      return [];
    }
  }
}