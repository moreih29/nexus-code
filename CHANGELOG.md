# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0-phase-a] — 2026-04-24

### Completed

- Phase A Runnable Shell 게이트를 2026-04-24에 PASS 판정으로 종료. 자동화 증거(14:44–14:52 KST)와 인간 수동 검증(15:30 KST 종료)을 모두 통과.
- 포함 범위: M0 잔여 항목과 E1·E2 실기 통합. 3개 워크스페이스 열기·닫기·전환, 다중 터미널 탭, 한국어 IME 수동 입력 확인, 세션 재시작 복원을 검증.
- 종료 시 sidecar·node-pty 프로세스 누락 없음을 프로세스 라이프사이클 자동 증거와 수동 확인으로 확보.
- sidecar WebSocket IPC·schema codegen은 E3 이관 결정. 서명 및 notarize는 로드맵 외 사용자 외부 작업으로 분리.
- 원본 상세 증거는 과거 커밋에서 추적하고, `git show <commit>:<path>`로 개별 파일을 복원할 수 있다.
