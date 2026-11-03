import { TestBed } from '@angular/core/testing';

import { AiRiskService } from './ai-risk';

describe('AiRiskService', () => {
  let service: AiRiskService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(AiRiskService);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });
});
