"""Python backtest engine for the PPO strategy search; rule-for-rule equal to the Node engine (see tests/ppo/parity)."""
from .runner import run, run_many, workers
from .strategy import Frame, from_engine, to_engine
