import socket
from typing import Any, Dict, List

import psutil

_VIRTUAL_NAME_HINTS = (
    "virtual", "vbox", "vmware", "wsl", "vethernet", "loopback", "bluetooth", "pseudo",
    "docker", "hyper-v", "tailscale", "zerotier", "tap", "tun", "wintun", "clash", "meta",
    "mihomo", "sing-box", "wireguard", "openvpn", "vpn", "proxy", "securesocket", "ppp",
    "veth", "br-", "virbr", "utun",
)
_WIFI_HINTS = ("wi-fi", "wifi", "wlan", "wireless", "802.11", "wlp", "wlx")
_LAN_HINTS = ("ethernet", "eth", "lan", "enp", "eno", "ens")
_VIRTUAL_PREFIXES = ("198.18.", "198.19.", "169.254.", "100.64.")


def _default_route_ip() -> str:
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.settimeout(0.2)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return ""


def _is_private_lan(ip: str) -> bool:
    if ip.startswith("192.168.") or ip.startswith("10."):
        return True
    if ip.startswith("172."):
        try:
            return 16 <= int(ip.split(".")[1]) <= 31
        except ValueError:
            return False
    return False


def local_adapters() -> List[Dict[str, Any]]:
    """List IPv4 adapters, best candidate for phone connection first."""
    default_ip = _default_route_ip()
    results: List[Dict[str, Any]] = []
    seen = set()
    try:
        stats = psutil.net_if_stats()
        for name, addrs in psutil.net_if_addrs().items():
            low = name.lower()
            stat = stats.get(name)
            is_up = stat.isup if stat else True
            name_virtual = any(h in low for h in _VIRTUAL_NAME_HINTS)
            is_wifi = any(h in low for h in _WIFI_HINTS)
            is_lan = any(h in low for h in _LAN_HINTS)
            for addr in addrs:
                if addr.family != socket.AF_INET:
                    continue
                ip = addr.address
                if not ip or ip.startswith("127.") or ip in seen:
                    continue
                seen.add(ip)
                virtual = name_virtual or ip.startswith(_VIRTUAL_PREFIXES)
                kind = "virtual" if virtual else "wifi" if is_wifi else "ethernet" if is_lan else "other"
                score = 0
                if virtual:
                    score -= 1000
                else:
                    score += {"wifi": 500, "ethernet": 300}.get(kind, 200)
                    score += 150 if _is_private_lan(ip) else 0
                    score += 50 if is_up else 0
                    score += 25 if ip == default_ip else 0
                results.append({"ip": ip, "interface": name, "kind": kind, "is_up": is_up, "score": score})
    except Exception:
        pass

    results.sort(key=lambda r: -r["score"])
    if not results:
        results.append({"ip": "127.0.0.1", "interface": "localhost", "kind": "loopback", "is_up": True, "score": 0})
    for idx, item in enumerate(results):
        item["is_primary"] = idx == 0
        del item["score"]
    return results
