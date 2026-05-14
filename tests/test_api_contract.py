from backend.app import CHANNELS, SAMPLE_MESSAGES


def test_channels_have_unique_keys():
    keys = [channel.key for channel in CHANNELS]
    assert len(keys) == len(set(keys))


def test_sample_messages_reference_known_channels():
    known = {channel.key for channel in CHANNELS}
    assert {message["channel"] for message in SAMPLE_MESSAGES} <= known

