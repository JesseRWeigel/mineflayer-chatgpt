# Combat Neural Net Research — RTX 5090 Local Implementation

## Executive Summary

Train a small PPO combat policy network on a Python simulator, export to ONNX, and serve it via the existing neural bridge. The RTX 5090 (32GB VRAM) can handle both the LLM (qwen3:32b ~20GB) and the combat net (~50MB) simultaneously.

## Architecture: Two-Tier Decision Making

```
LLM (Qwen3:32B via Ollama)          Neural Combat Policy (MLP via ONNX)
├── "Should I fight or flee?"        ├── Attack timing (50ms ticks)
├── "What goal next?"                ├── Strafing patterns
└── Calls neural_combat(10)          ├── Shield use timing
                                     └── Retreat decisions
    Strategic layer (~3s/decision)       Tactical layer (~1ms/tick)
```

## Combat Policy Network

### Input Features (extend current `NeuralObservation`)
- `bot_health`, `bot_food`, `bot_pos` (existing)
- `nearest_hostile.distance`, `.angle`, `.health` (existing)
- **Add:** `bot_yaw`, `bot_pitch` (facing direction)
- **Add:** `hostile_yaw` (predict attack timing)
- **Add:** `on_ground` flag (jump-attack availability)
- **Add:** `cooldown_ticks` (MC 1.9+ sword cooldown — critical)
- **Add:** `biome`/`light_level` (mob behavior context)

### Output Space (6 discrete actions)
1. `attack` — swing weapon at nearest hostile
2. `strafe_left` — circle-strafe left
3. `strafe_right` — circle-strafe right
4. `flee` — run away from nearest threat
5. `use_item` — use shield/bow/food
6. `idle` — wait for better opportunity

### Model Architecture
```python
class CombatPolicy(nn.Module):
    def __init__(self, obs_dim=16, n_actions=6):
        super().__init__()
        self.net = nn.Sequential(
            nn.Linear(obs_dim, 256), nn.Tanh(),
            nn.Linear(256, 256), nn.Tanh(),
        )
        self.policy_head = nn.Linear(256, n_actions)  # PPO actor
        self.value_head = nn.Linear(256, 1)            # PPO critic
```

~50MB model. Inference in microseconds. Fits alongside qwen3:32b on 5090.

### Training Approach

1. **Python combat simulator** (fastest path):
   - Mirror `NeuralObservation` schema in a `gym.Env`
   - Simulate 50ms ticks: update bot/hostile positions, apply damage
   - Reward: +1 attack lands, -1 health lost, +10 hostile killed, -20 bot dies
   - Train with CleanRL PPO: ~10M steps, ~5 hours on 5090
   - 4096 parallel environments → ~2M steps/hour

2. **Export and serve**:
   - TorchScript: `torch.jit.script(model).save("combat_policy.pt")`
   - Or ONNX for cross-language: `torch.onnx.export(model, ...)`
   - Drop into existing `neural_server.py` replacing `heuristic_policy`

3. **Long-term: eliminate Python for inference**:
   - Export to ONNX → load with `onnxruntime-node` in TypeScript
   - Neural combat runs in-process, no IPC latency
   - Keep Python only for training

## Bridge Improvements

### Current: Per-query TCP connections
```
bridge.ts → TCP connect → neural_server.py → response → close
```
~1-2ms overhead per query. Fine at 50ms/tick but wasteful.

### Recommended: Persistent Unix socket
```
bridge.ts → Unix socket (persistent) → neural_server.py → response
```
~50-100 microseconds. Change 2 lines in each file.

## Local LLM Options (32GB VRAM)

| Model | VRAM (Q4_K_M) | Tokens/sec (5090) | Use Case |
|---|---|---|---|
| **Qwen3:32B Q4** | ~20GB | ~61 t/s | Strategic planning (recommended) |
| **Qwen2.5:14B Q8** | ~16GB | ~100+ t/s | Fast reactions (alternative fast model) |
| **DeepSeek-R1:32B Q4** | ~20GB | ~61 t/s | Strong reasoner alternative |
| **Gemma3:27B Q4** | ~18GB | ~70 t/s | Good instruction following |

Current setup (qwen3:32b strategic + qwen3:8b reactive) is optimal for 32GB VRAM.

## Research References

- **MineRL Diamond Competition** — NeurIPS 2021: CNN+LSTM+PPO architectures won. Key finding: structured observations (like ours) beat pixel input for combat.
- **OpenAI VPT** — 0.5B params on 70k hours of video. Our stub in `neural_server.py` references `CraftJarvis/MineStudio_VPT.rl_for_shoot_animals_2x`.
- **STEVE-1** — Goal-conditioned agent built on VPT. Can run locally but needs pixel input.
- **Voyager** — LLM-generated JavaScript combat skills. Our skill system mirrors this.
- **Mindcraft** — Pure LLM + mineflayer. No neural combat policy.
- **CleanRL PPO** — Best reference implementation for our training: docs.cleanrl.dev/rl-algorithms/ppo/

## Implementation Roadmap

### Phase 1 (2-3 days): Upgrade existing bridge
- Switch TCP to persistent Unix socket in `src/neural/bridge.ts`
- Add `bot_yaw`, `hostile_yaw`, `cooldown_ticks` to `buildObservation()`
- Already done: event-driven brain with dual model strategy

### Phase 2 (3-5 days): Train combat policy
- Write Python combat simulator matching `NeuralObservation` schema
- Train PPO with CleanRL: ~10M steps, ~5 hours on 5090
- Export to TorchScript, wire into `neural_server.py`

### Phase 3 (1 week): Eliminate Python for inference
- Export trained policy to ONNX
- Load with `onnxruntime-node` in TypeScript
- Remove TCP bridge entirely; inference runs in-process

### Phase 4 (optional): VPT fine-tuning
- Load MineStudio VPT model (our existing stub)
- Fine-tune on simulator trajectories for better generalization
