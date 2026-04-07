<!-- tags: rules, conventions, tdd, architecture -->
# 개발 규칙

## 코드 스타일
- TypeScript strict mode
- kebab-case 파일명
- 한글 UI 텍스트, 한글 주석 허용

## 테스트
- TDD: 기능 구현 전 테스트 먼저 작성
- 각 모듈은 독립적으로 테스트 가능해야 함
- 외부 의존(CLI, 파일시스템 등)은 테스트에서 격리

## 커밋
- conventional commits (구체 접두어는 프레임워크 결정 후)
- 한 커밋에 한 관심사

## 아키텍처
- 모듈 간 결합도 최소화
- 명시적 의존성 주입 (글로벌 상태 금지)
- 모든 외부 입력에 런타임 검증
- 이벤트 리스너는 반드시 해제 함수 제공

## 에러 처리
- empty catch 금지
- 에러는 삼키지 않고 명시적으로 처리