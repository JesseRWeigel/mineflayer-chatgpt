#!/usr/bin/env python3
"""
Neural combat server for minecraft-ai-streamer.
Receives JSON obs via TCP, returns action decisions.
Run: python3 neural_server.py [--port 12345] [--model heuristic|vpt]
"""
import socket, json, sys, argparse, logging, math, random

logging.basicConfig(level=logging.INFO, format="[Neural] %(message)s")
log = logging.getLogger(__name__)

def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("--port", type=int, default=12345)
    p.add_argument("--model", choices=["heuristic", "vpt"], default="heuristic")
    return p.parse_args()

# Observation schema (from TypeScript bridge):
# { bot_health, bot_food, bot_pos, nearest_hostile, all_entities, has_sword, has_shield, has_bow }
# Response schema:
# { action: "attack"|"strafe_left"|"strafe_right"|"flee"|"use_item"|"idle", confidence: float }

def heuristic_policy(obs: dict) -> dict:
    health = obs.get("bot_health", 20)
    hostile = obs.get("nearest_hostile")
    all_entities = obs.get("all_entities", [])

    if health <= 4:
        return {"action": "flee", "confidence": 0.99}
    if hostile is None:
        return {"action": "idle", "confidence": 0.95}

    dist = hostile["distance"]
    angle = abs(hostile.get("angle", 0))
    nearby_count = sum(1 for e in all_entities if e.get("distance", 99) < 8)

    if nearby_count >= 3 and health < 15:
        return {"action": "flee", "confidence": 0.85}
    if angle > 90:
        return {"action": "strafe_left", "confidence": 0.7}
    if dist > 6:
        return {"action": "attack", "confidence": 0.6}
    if dist <= 3 and angle < 45:
        return {"action": "attack", "confidence": 0.95}
    if dist <= 6:
        return {"action": random.choice(["strafe_left", "strafe_right"]), "confidence": 0.75}
    return {"action": "attack", "confidence": 0.6}

def load_vpt_model():
    try:
        import torch
        from minestudio.models import VPTPolicy
        model = VPTPolicy.from_pretrained(
            "CraftJarvis/MineStudio_VPT.rl_for_shoot_animals_2x"
        ).eval()
        if torch.cuda.is_available():
            model = model.cuda()
        log.info("VPT model loaded")
        return model
    except Exception as e:
        log.warning(f"VPT unavailable ({e}) -- using heuristic")
        return None

def handle_connection(conn, policy_fn):
    try:
        data = b""
        while True:
            chunk = conn.recv(4096)
            if not chunk: break
            data += chunk
            if b"\n" in data or len(data) > 8192: break
        if not data: return
        obs = json.loads(data.decode().strip())
        action = policy_fn(obs)
        conn.sendall((json.dumps(action) + "\n").encode())
    except Exception as e:
        log.warning(f"Connection error: {e}")
        conn.sendall(b'{"action":"idle","confidence":0.5}\n')
    finally:
        conn.close()

def main():
    args = parse_args()
    model = load_vpt_model() if args.model == "vpt" else None
    if model:
        log.warning("VPT model loaded but not yet wired into policy — using heuristic. Extend policy lambda to use model.")
    policy = lambda obs: heuristic_policy(obs)  # TODO: replace with VPT inference when ready

    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind(("127.0.0.1", args.port))
    server.listen(10)
    log.info(f"Ready on port {args.port} (policy={args.model})")

    try:
        while True:
            conn, _ = server.accept()
            handle_connection(conn, policy)
    except KeyboardInterrupt:
        log.info("Stopped.")
    finally:
        server.close()

if __name__ == "__main__":
    main()
