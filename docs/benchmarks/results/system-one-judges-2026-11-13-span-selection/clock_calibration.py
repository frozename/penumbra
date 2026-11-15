import math


def estimate_offset(client_before, client_after, remote):
    if not all(isinstance(value, (int, float)) and math.isfinite(value) for value in [client_before, client_after, remote]):
        raise ValueError('missing clock evidence')
    duration = client_after - client_before
    if not 0 <= duration <= 1:
        raise ValueError('clock round trip exceeds bound')
    return remote - (client_before + client_after) / 2, duration / 2
