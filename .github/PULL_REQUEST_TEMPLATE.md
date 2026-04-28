## 변경 요약

<!-- 이번 PR에서 무엇을 바꾸는지 짧게 적는다. -->

## 회귀 가드

변경 범위에 해당하지 않는 항목은 체크하지 말고, 아래에 `N/A: <사유>`를 적는다.

- [ ] layout-critical 또는 service-boundary 변경이 포함되어 있으면, 동일 PR에 system smoke fixture를 추가/갱신했다.
- [ ] service interface를 변경했으면, 관련 contract test를 함께 갱신했다.
- [ ] service 변경이 포함되어 있으면, 변경된 service의 모든 public method를 unit test가 100% 커버한다. (method-level 기준, branch coverage 요구 아님)

## 비고 / N/A 사유

<!-- 회귀 가드 항목 중 해당 없음이 있으면 근거를 남긴다. -->
