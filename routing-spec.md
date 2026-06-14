# Event Routing Specification

## 기준 (한 줄 원칙)
**broadcast** = 공유 상태(모든 클라이언트가 동일하게 보여야 하는 것) / **sendTo** = 경쟁 정보(해당 플레이어에게만, 상대방이 알면 전략적 불이익)

---

## broadcast 이벤트

| 이벤트 | 사유 |
|--------|------|
| `state` | 전체 게임 상태 동기화 (적 HP·플레이어 위치 등) |
| `wave_start` | 웨이브 시작 — 모든 플레이어 동시 인지 |
| `wave_clear` | 웨이브 클리어 — 모든 플레이어 보상 대상 |
| `wave_prep` | 다음 웨이브 카운트다운 — 공유 |
| `enemy_spawn` | 적 스폰 — 공유 시각화 |
| `enemy_die` | 적 사망 — 공유 이펙트·점수 |
| `enemy_heal` | 힐러 회복 — 공유 상태 변화 (QA 재현용 로그 포함) |
| `hit` | 피해 판정 — 공유 이펙트·HP 동기화 |
| `co_combo_hit` | 협동 콤보 + elemental_surge — 공유 상태 (서버 판정) |
| `spell_cast` | 주문 발동 시각화 — 공유 |
| `attack_anim` | 적 공격 애니메이션 windup/strike — 공유 |
| `boss_spawn` | 보스 등장 — 공유 |
| `player_die` | 플레이어 사망 — 공유 |
| `player_revive` | 플레이어 부활 — 공유 |
| `player_disconnect` | 연결 끊김 알림 — 공유 |
| `player_joined` / `player_left` | 룸 구성 변화 — 공유 |
| `host_changed` | 호스트 변경 — 공유 |
| `level_up` | 레벨업 알림 — 공유 관전 (세부 옵션은 sendTo) |
| `augment_selected` | 증강 선택 결과 — 공유 (세부 옵션 선택은 sendTo) |
| `shape_unlocked` | 도형 해금 — 공유 시각화 |
| `shape_recognized` | 도형 인식 결과 — 공유 시각화 |
| `countdown` | 게임 시작 카운트다운 — 공유 |
| `game_over` | 게임 종료 — 공유 |
| `advisor` | 어드바이저 메시지 — 공유 |
| `shield_defense` | 방패 방어 패턴 진입/종료 — 공유 시각화 (서버 AI 권위) |

---

## sendTo 이벤트 (Private)

| 이벤트 | 사유 |
|--------|------|
| `spell_result` | 내 주문 결과 (성공·실패·사유) — **경쟁 정보**: 상대가 내 쿨다운·마나 정황을 추론하면 불이익 |
| `augment_options` | 내 레벨업 선택지 — **경쟁 정보**: 상대가 내 성장 방향을 알면 대응 전략 가능 |
| `level_up_queued` | 내 큐잉 알림 — 개인 정보 |
| `room_created` / `room_joined` / `room_error` | 룸 입장 결과 — 개인 |
| `connected` / `reconnected` | 연결 정보 — 개인 |
| `error` | 오류 메시지 — 개인 |

---

## 주의: `state` 내 경쟁 정보 포함 여부
`state` (broadcast)에는 상대 플레이어의 `mana`·`spellCooldown`이 포함된다.
이는 **의도된 설계** — 협동 게임에서 두 플레이어가 서로의 상태를 보고 전략을 맞춰야 하기 때문.
진정한 '경쟁 정보'는 **선택 내용**(증강 옵션·주문 실패 사유)에 한정되며, 이는 sendTo로 처리한다.
