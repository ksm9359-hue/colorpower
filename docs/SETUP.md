# 개발 환경 설정 (SETUP)

## 요구 사항

- Node.js LTS (권장: 20 이상)
- npm (Node 설치 시 포함)
- Git

## 설치 및 실행

```bash
npm install
npm run dev
```

## 주요 스크립트

- `npm run dev`: 로컬 개발 서버 실행
- `npm run build`: 프로덕션 빌드 생성
- `npm run preview`: 빌드 결과 로컬 미리보기
- `npm run typecheck`: 타입 검사

## 권장 개발 규칙

- 기능 단위 브랜치 사용 (`feature/*`)
- 커밋은 작게 나누기
- 변경 시 `README.md` 또는 관련 문서 동시 업데이트
