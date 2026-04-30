# 배포 가이드 (GitHub Pages)

## 1) 저장소 준비

1. GitHub에 저장소 생성
2. 로컬 프로젝트를 원격 저장소와 연결
3. 기본 브랜치를 `main`으로 사용

## 2) 자동 배포 워크플로우

이 프로젝트에는 `.github/workflows/deploy.yml`이 포함되어 있습니다.

- `main` 브랜치에 push되면 자동으로 빌드
- 결과물을 GitHub Pages로 배포

## 3) GitHub Pages 설정

저장소 설정에서:

- `Settings` -> `Pages`
- Source를 `GitHub Actions`로 설정

## 4) 배포 확인

- Actions 탭에서 `Deploy to GitHub Pages` 성공 확인
- 생성된 Pages URL 접속

## 5) 트러블슈팅

- 화면이 깨질 때: `vite.config.ts`의 `base: './'` 확인
- 빌드 실패 시: `npm run build`를 로컬에서 먼저 실행해 원인 확인
